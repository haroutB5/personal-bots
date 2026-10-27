/*
 * pbdesk-wl: Linux desktop helper for Hyprland (hbots computer_* tools).
 *
 * One long-lived process, no root, no daemon, no uinput. It owns
 *   - zwlr_virtual_pointer_manager_v1  (move, button, click, scroll, drag)
 *   - zwp_virtual_keyboard_manager_v1  (keys, chords, text, holds)
 * and uploads the *system* keymap once, so clients keep a clean layout.
 *
 * Protocol: one command per line on stdin, "ok <id> <us>" per command after a
 * roundtrip; "err <id> <message>" for a command that could not be done. Text
 * after the "type " command is taken literally (the driver splits newlines).
 *
 *   <id> ping
 *   <id> status
 *   <id> layout NAME
 *   <id> move X Y EXT_W EXT_H
 *   <id> button left|right|middle down|up
 *   <id> click left|right|middle COUNT EXT_W EXT_H
 *   <id> scroll DX DY
 *   <id> drag X1 Y1 X2 Y2 EXT_W EXT_H BUTTON STEPS MS
 *   <id> key NAME down|up
 *   <id> type TEXT
 *   <id> hold NAME MS
 *   <id> releaseall        (alias: panic)
 *   <id> quit
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/input-event-codes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>
#include <xkbcommon/xkbcommon.h>

#include "wlr-virtual-pointer-unstable-v1.h"
#include "virtual-keyboard-unstable-v1.h"

static struct wl_display *g_display;
static struct wl_seat *seat;
static struct zwlr_virtual_pointer_manager_v1 *ptr_manager;
static struct zwlr_virtual_pointer_v1 *ptr;
static struct zwp_virtual_keyboard_manager_v1 *kb_manager;
static struct zwp_virtual_keyboard_v1 *vk;
static struct xkb_context *xkb_ctx;
static struct xkb_keymap *xkb_map;
static char g_layout[64] = "us";
static unsigned char buttons_down[512];
static unsigned char keys_down[512];
static int depressed = 0; /* xkb modifier mask the helper has set */

static uint32_t now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint32_t)(ts.tv_sec * 1000u + ts.tv_nsec / 1000000u);
}

static uint64_t now_us(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000000u + (uint64_t)ts.tv_nsec / 1000u;
}

static void sleep_ms(int ms) {
  if (ms > 0) usleep((useconds_t)ms * 1000u);
}

static int button_code(const char *name) {
  if (strcmp(name, "left") == 0) return BTN_LEFT;
  if (strcmp(name, "right") == 0) return BTN_RIGHT;
  if (strcmp(name, "middle") == 0) return BTN_MIDDLE;
  if (strcmp(name, "side") == 0) return BTN_SIDE;
  if (strcmp(name, "extra") == 0) return BTN_EXTRA;
  return -1;
}

static void move_abs(int x, int y, int w, int h) {
  if (w < 1) w = 1;
  if (h < 1) h = 1;
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x >= w) x = w - 1;
  if (y >= h) y = h - 1;
  zwlr_virtual_pointer_v1_motion_absolute(ptr, now_ms(), (uint32_t)x, (uint32_t)y,
                                          (uint32_t)w, (uint32_t)h);
  zwlr_virtual_pointer_v1_frame(ptr);
  wl_display_roundtrip(g_display);
}

static void button_event(int code, int down) {
  zwlr_virtual_pointer_v1_button(ptr, now_ms(), (uint32_t)code,
                                 down ? WL_POINTER_BUTTON_STATE_PRESSED
                                      : WL_POINTER_BUTTON_STATE_RELEASED);
  zwlr_virtual_pointer_v1_frame(ptr);
  wl_display_roundtrip(g_display);
}

static void scroll_axis(int axis, double notches) {
  int steps = (int)(notches < 0 ? -notches : notches);
  double value = notches * 15.0;
  zwlr_virtual_pointer_v1_axis_source(ptr, WL_POINTER_AXIS_SOURCE_WHEEL);
  zwlr_virtual_pointer_v1_axis(ptr, now_ms(), (uint32_t)axis, wl_fixed_from_double(value));
  zwlr_virtual_pointer_v1_axis_discrete(ptr, now_ms(), (uint32_t)axis,
                                        wl_fixed_from_double(value), steps);
  zwlr_virtual_pointer_v1_frame(ptr);
  wl_display_roundtrip(g_display);
}

/* ---- keyboard ---- */

static void send_mods(void) {
  zwp_virtual_keyboard_v1_modifiers(vk, (uint32_t)depressed, 0, 0, 0);
  wl_display_roundtrip(g_display);
}

static int modifier_mask(const char *name) {
  if (strcmp(name, "Control_L") == 0 || strcmp(name, "Control_R") == 0) return 4;
  if (strcmp(name, "Shift_L") == 0 || strcmp(name, "Shift_R") == 0) return 1;
  if (strcmp(name, "Alt_L") == 0 || strcmp(name, "Alt_R") == 0) return 8;
  if (strcmp(name, "Super_L") == 0 || strcmp(name, "Super_R") == 0) return 64;
  if (strcmp(name, "Caps_Lock") == 0) return 2;
  return 0;
}

static int send_keycode(int code, int down) {
  if (code <= 0 || code >= 512) return 0;
  zwp_virtual_keyboard_v1_key(vk, now_ms(), (uint32_t)(code - 8),
                              down ? WL_KEYBOARD_KEY_STATE_PRESSED
                                   : WL_KEYBOARD_KEY_STATE_RELEASED);
  keys_down[code] = (unsigned char)down;
  wl_display_roundtrip(g_display);
  return 1;
}

/* Find the keycode and shift level for a keysym in the active keymap. */
static int keycode_for(xkb_keysym_t sym, int *level) {
  xkb_keycode_t min = xkb_keymap_min_keycode(xkb_map);
  xkb_keycode_t max = xkb_keymap_max_keycode(xkb_map);
  for (xkb_keycode_t kc = min; kc <= max; kc++) {
    for (int lv = 0; lv < 4; lv++) {
      const xkb_keysym_t *syms = NULL;
      int n = xkb_keymap_key_get_syms_by_level(xkb_map, kc, 0, lv, &syms);
      for (int i = 0; i < n; i++) {
        if (syms[i] == sym) {
          *level = lv;
          return (int)kc;
        }
      }
    }
  }
  return 0;
}

/* Press a keysym, pressing Shift first when the keymap needs it. */
static int keysym_down(const char *name) {
  xkb_keysym_t sym = xkb_keysym_from_name(name, XKB_KEYSYM_CASE_INSENSITIVE);
  if (sym == XKB_KEY_NoSymbol) return 0;
  int level = 0;
  int code = keycode_for(sym, &level);
  if (code == 0) return 0;
  int mask = modifier_mask(name);
  if (mask) {
    depressed |= mask;
    send_mods();
  }
  if ((level & 1) && !(depressed & 1)) {
    depressed |= 1;
    send_mods();
  }
  return send_keycode(code, 1);
}

static int keysym_up(const char *name) {
  xkb_keysym_t sym = xkb_keysym_from_name(name, XKB_KEYSYM_CASE_INSENSITIVE);
  if (sym == XKB_KEY_NoSymbol) return 0;
  int level = 0;
  int code = keycode_for(sym, &level);
  if (code == 0) return 0;
  int ok = send_keycode(code, 0);
  if ((level & 1) && (depressed & 1)) {
    depressed &= ~1;
    send_mods();
  }
  int mask = modifier_mask(name);
  if (mask) {
    depressed &= ~mask;
    send_mods();
  }
  return ok;
}

/*
 * Types literal UTF-8 text. Returns 0 when every character was typed, else the
 * codepoint that the layout cannot produce (typing stops there, rather than
 * silently dropping the character).
 */
static uint32_t type_text(const char *text) {
  const unsigned char *p = (const unsigned char *)text;
  while (*p) {
    uint32_t cp = 0;
    int len = 0;
    if (*p < 0x80) {
      cp = *p;
      len = 1;
    } else if ((*p & 0xE0) == 0xC0 && p[1]) {
      cp = (uint32_t)(((*p & 0x1F) << 6) | (p[1] & 0x3F));
      len = 2;
    } else if ((*p & 0xF0) == 0xE0 && p[1] && p[2]) {
      cp = (uint32_t)(((*p & 0x0F) << 12) | ((p[1] & 0x3F) << 6) | (p[2] & 0x3F));
      len = 3;
    } else if ((*p & 0xF8) == 0xF0 && p[1] && p[2] && p[3]) {
      cp = (uint32_t)(((*p & 0x07) << 18) | ((p[1] & 0x3F) << 12) | ((p[2] & 0x3F) << 6) |
                      (p[3] & 0x3F));
      len = 4;
    } else {
      return 0xFFFD;
    }
    xkb_keysym_t sym = xkb_utf32_to_keysym(cp);
    char name[64];
    if (sym == XKB_KEY_NoSymbol || xkb_keysym_get_name(sym, name, sizeof(name)) <= 0) {
      return cp;
    }
    if (!keysym_down(name)) {
      return cp;
    }
    sleep_ms(6);
    keysym_up(name);
    wl_display_roundtrip(g_display);
    p += len;
    sleep_ms(4);
  }
  return 0;
}

/* Panic release: tracked keys, the four modifiers, and the three main mouse
 * buttons, sent even when the helper did not see the press (a previous helper
 * crashed while holding it). Harmless when nothing is down. */
static void release_all(void) {
  for (int i = 0; i < 512; i++) {
    if (keys_down[i]) send_keycode(i, 0);
  }
  const int modifiers[] = {37 /* Ctrl */, 50 /* Shift */, 64 /* Alt */, 133 /* Super */};
  for (unsigned i = 0; i < sizeof(modifiers) / sizeof(modifiers[0]); i++) {
    send_keycode(modifiers[i], 0);
  }
  depressed = 0;
  if (vk != NULL) send_mods();
  for (int i = 0; i < 512; i++) {
    if (buttons_down[i]) {
      button_event(i, 0);
      buttons_down[i] = 0;
    }
  }
  button_event(BTN_LEFT, 0);
  button_event(BTN_RIGHT, 0);
  button_event(BTN_MIDDLE, 0);
}

static void teardown_keyboard(void) {
  if (vk != NULL) {
    zwp_virtual_keyboard_v1_destroy(vk);
    vk = NULL;
  }
  if (xkb_map != NULL) {
    xkb_keymap_unref(xkb_map);
    xkb_map = NULL;
  }
  if (xkb_ctx != NULL) {
    xkb_context_unref(xkb_ctx);
    xkb_ctx = NULL;
  }
}

/* Compile and upload the keymap for `layout`. The system keymap, uploaded once
 * for the life of the process, is what keeps held keys resolving correctly. */
static int setup_keyboard(const char *layout) {
  teardown_keyboard();
  snprintf(g_layout, sizeof(g_layout), "%s", layout);
  xkb_ctx = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
  if (xkb_ctx == NULL) return 0;
  struct xkb_rule_names names = {.rules = NULL, .model = NULL,
                                 .layout = layout, .variant = NULL, .options = NULL};
  xkb_map = xkb_keymap_new_from_names(xkb_ctx, &names, XKB_KEYMAP_COMPILE_NO_FLAGS);
  if (xkb_map == NULL) return 0;
  char *str = xkb_keymap_get_as_string(xkb_map, XKB_KEYMAP_FORMAT_TEXT_V1);
  if (str == NULL) return 0;
  size_t len = strlen(str) + 1;
  int fd = memfd_create("pbdesk-keymap", MFD_CLOEXEC);
  if (fd < 0) {
    free(str);
    return 0;
  }
  if (write(fd, str, len) != (ssize_t)len) {
    close(fd);
    free(str);
    return 0;
  }
  lseek(fd, 0, SEEK_SET);
  if (seat == NULL) {
    close(fd);
    free(str);
    return 0;
  }
  vk = zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(kb_manager, seat);
  if (vk == NULL) {
    close(fd);
    free(str);
    return 0;
  }
  zwp_virtual_keyboard_v1_keymap(vk, WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1, fd, (uint32_t)len);
  close(fd);
  free(str);
  zwp_virtual_keyboard_v1_modifiers(vk, 0, 0, 0, 0);
  wl_display_roundtrip(g_display);
  if (wl_display_get_error(g_display) != 0) return 0;
  return 1;
}

static int count_set(const unsigned char *flags) {
  int n = 0;
  for (int i = 1; i < 512; i++) {
    if (flags[i]) n++;
  }
  return n;
}

int main(int argc, char **argv) {
  const char *layout = argc > 1 ? argv[1] : "us";
  struct wl_display *display = wl_display_connect(NULL);
  if (display == NULL) {
    fprintf(stderr, "pbdesk-wl: cannot connect to WAYLAND_DISPLAY=%s\n",
            getenv("WAYLAND_DISPLAY") ? getenv("WAYLAND_DISPLAY") : "(unset)");
    return 2;
  }
  g_display = display;
  struct wl_registry *registry = wl_display_get_registry(display);
  extern const struct wl_registry_listener pbdesk_registry_listener;
  wl_registry_add_listener(registry, &pbdesk_registry_listener, NULL);
  if (wl_display_roundtrip(display) < 0) {
    fprintf(stderr, "pbdesk-wl: registry roundtrip failed\n");
    return 2;
  }
  if (ptr_manager == NULL || kb_manager == NULL) {
    fprintf(stderr, "pbdesk-wl: missing virtual pointer (%p) or keyboard (%p) manager\n",
            (void *)ptr_manager, (void *)kb_manager);
    return 3;
  }
  ptr = zwlr_virtual_pointer_manager_v1_create_virtual_pointer(ptr_manager, NULL);
  if (ptr == NULL || !setup_keyboard(layout)) {
    fprintf(stderr, "pbdesk-wl: failed to create virtual devices\n");
    return 3;
  }
  wl_display_roundtrip(display);
  printf("ready layout=%s pid=%ld\n", g_layout, (long)getpid());
  fflush(stdout);

  char line[16384];
  while (fgets(line, sizeof(line), stdin) != NULL) {
    uint64_t started = now_us();
    long id = 0;
    char cmd[32];
    int n = sscanf(line, "%ld %31s", &id, cmd);
    if (n < 2) continue;
    const char *err = NULL;

    if (strcmp(cmd, "ping") == 0) {
      wl_display_roundtrip(display);
    } else if (strcmp(cmd, "status") == 0) {
      printf("ok %ld %llu layout=%s keys=%d buttons=%d\n", id,
             (unsigned long long)(now_us() - started), g_layout, count_set(keys_down),
             count_set(buttons_down));
      fflush(stdout);
      continue;
    } else if (strcmp(cmd, "layout") == 0) {
      char name[64];
      if (sscanf(line, "%*d %*s %63s", name) == 1) {
        if (strchr(name, ',') != NULL) {
          /* Hyprland's layout option can be a comma list ("us,fr"); the helper
           * speaks one XKB layout, so the first is the one that types. */
          name[strcspn(name, ",")] = '\0';
        }
        /* A rebuild destroys the virtual keyboard; let go of anything held
         * first so the compositor cannot keep a stale key down. */
        release_all();
        if (!setup_keyboard(name)) err = "cannot load that keyboard layout";
      }
    } else if (strcmp(cmd, "move") == 0) {
      int x, y, w, h;
      if (sscanf(line, "%*d %*s %d %d %d %d", &x, &y, &w, &h) == 4) move_abs(x, y, w, h);
    } else if (strcmp(cmd, "button") == 0) {
      char name[16], state[16];
      if (sscanf(line, "%*d %*s %15s %15s", name, state) == 2) {
        int code = button_code(name);
        int down = strcmp(state, "down") == 0;
        if (code > 0) {
          button_event(code, down);
          if (code < 512) buttons_down[code] = (unsigned char)down;
        }
      }
    } else if (strcmp(cmd, "click") == 0) {
      char name[16];
      int count, x, y, w, h;
      if (sscanf(line, "%*d %*s %15s %d %d %d %d %d", name, &count, &x, &y, &w, &h) == 6) {
        int code = button_code(name);
        if (count < 1) count = 1;
        if (count > 3) count = 3;
        if (code > 0) {
          move_abs(x, y, w, h);
          sleep_ms(15);
          for (int i = 0; i < count; i++) {
            button_event(code, 1);
            sleep_ms(20);
            button_event(code, 0);
            if (i + 1 < count) sleep_ms(45);
          }
        }
      }
    } else if (strcmp(cmd, "scroll") == 0) {
      double dx, dy;
      if (sscanf(line, "%*d %*s %lf %lf", &dx, &dy) == 2) {
        if (dy != 0.0) scroll_axis(WL_POINTER_AXIS_VERTICAL_SCROLL, dy);
        if (dx != 0.0) scroll_axis(WL_POINTER_AXIS_HORIZONTAL_SCROLL, dx);
      }
    } else if (strcmp(cmd, "drag") == 0) {
      int x1, y1, x2, y2, w, h, steps, ms;
      char name[16];
      if (sscanf(line, "%*d %*s %d %d %d %d %d %d %15s %d %d", &x1, &y1, &x2, &y2, &w, &h,
                 name, &steps, &ms) == 9) {
        int code = button_code(name);
        if (code > 0) {
          if (steps < 2) steps = 2;
          if (steps > 60) steps = 60;
          if (ms < 0) ms = 0;
          move_abs(x1, y1, w, h);
          sleep_ms(15);
          button_event(code, 1);
          for (int i = 1; i <= steps; i++) {
            int x = x1 + (x2 - x1) * i / steps;
            int y = y1 + (y2 - y1) * i / steps;
            zwlr_virtual_pointer_v1_motion_absolute(ptr, now_ms(), (uint32_t)x, (uint32_t)y,
                                                    (uint32_t)w, (uint32_t)h);
            zwlr_virtual_pointer_v1_frame(ptr);
            wl_display_roundtrip(g_display);
            sleep_ms(ms / steps);
          }
          button_event(code, 0);
        }
      }
    } else if (strcmp(cmd, "key") == 0) {
      char name[64], state[16];
      if (sscanf(line, "%*d %*s %63s %15s", name, state) == 2) {
        int ok = strcmp(state, "down") == 0 ? keysym_down(name) : keysym_up(name);
        if (!ok) err = "no key by that name in the layout";
      }
    } else if (strcmp(cmd, "type") == 0) {
      const char *text = strchr(line, ' ');
      if (text != NULL) {
        text = strchr(text + 1, ' ');
        if (text != NULL) {
          text++; /* skip "type " */
          size_t len = strlen(text);
          if (len > 0 && text[len - 1] == '\n') ((char *)text)[len - 1] = '\0';
          uint32_t bad = type_text(text);
          if (bad != 0) {
            printf("err %ld cannot type U+%04X: the layout has no key for it\n", id, bad);
            fflush(stdout);
            continue;
          }
        }
      }
    } else if (strcmp(cmd, "hold") == 0) {
      char name[64];
      int ms = 0;
      if (sscanf(line, "%*d %*s %63s %d", name, &ms) == 2) {
        if (ms < 0) ms = 0;
        if (ms > 30000) ms = 30000;
        if (keysym_down(name)) {
          sleep_ms(ms);
          keysym_up(name);
        } else {
          err = "no key by that name in the layout";
        }
      }
    } else if (strcmp(cmd, "releaseall") == 0 || strcmp(cmd, "panic") == 0) {
      release_all();
    } else if (strcmp(cmd, "quit") == 0) {
      release_all();
      printf("ok %ld %llu\n", id, (unsigned long long)(now_us() - started));
      fflush(stdout);
      break;
    } else {
      printf("err %ld unknown command\n", id);
      fflush(stdout);
      continue;
    }
    if (err != NULL) {
      printf("err %ld %s\n", id, err);
      fflush(stdout);
      continue;
    }
    printf("ok %ld %llu\n", id, (unsigned long long)(now_us() - started));
    fflush(stdout);
  }
  if (ptr != NULL) zwlr_virtual_pointer_v1_destroy(ptr);
  if (ptr_manager != NULL) zwlr_virtual_pointer_manager_v1_destroy(ptr_manager);
  teardown_keyboard();
  if (kb_manager != NULL) zwp_virtual_keyboard_manager_v1_destroy(kb_manager);
  wl_display_disconnect(display);
  return 0;
}

static void registry_global(void *data, struct wl_registry *registry, uint32_t name,
                            const char *interface, uint32_t version) {
  (void)data;
  if (strcmp(interface, zwlr_virtual_pointer_manager_v1_interface.name) == 0) {
    uint32_t use = version < 2 ? version : 2;
    ptr_manager = wl_registry_bind(registry, name, &zwlr_virtual_pointer_manager_v1_interface, use);
  } else if (strcmp(interface, zwp_virtual_keyboard_manager_v1_interface.name) == 0) {
    kb_manager = wl_registry_bind(registry, name, &zwp_virtual_keyboard_manager_v1_interface, 1);
  } else if (strcmp(interface, wl_seat_interface.name) == 0) {
    seat = wl_registry_bind(registry, name, &wl_seat_interface, 1);
  }
}

static void registry_global_remove(void *data, struct wl_registry *registry, uint32_t name) {
  (void)data;
  (void)registry;
  (void)name;
}

const struct wl_registry_listener pbdesk_registry_listener = {
    .global = registry_global,
    .global_remove = registry_global_remove,
};
