export function phoneWording(text: string): string {
  return text.replace(/\biPhone\b/g, "phone");
}
