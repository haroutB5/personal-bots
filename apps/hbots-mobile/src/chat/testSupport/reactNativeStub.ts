// react-native stand-in for tests that render real components through React's reconciler.
// The list copies RN 0.86.3: cells are PureComponents, so a cell re-renders only when its
// item, index or renderItem changes, and renderItem changes only with renderItem or extraData.
import { createElement, PureComponent, type ReactNode } from "react";

const host = (name: string) => (props: Record<string, unknown>) => createElement(name, props);
export const View = host("View");
export const Text = host("Text");
export const ScrollView = host("ScrollView");
export const Image = host("Image");
export const ActivityIndicator = host("ActivityIndicator");
export function Pressable(props: Record<string, unknown>) {
  const { style: _style, children, ...rest } = props as { style?: unknown; children?: ReactNode };
  return createElement("Pressable", rest, children);
}
export const StyleSheet = {
  create: <T>(styles: T): T => styles,
  absoluteFill: {},
  hairlineWidth: 1,
};
class AnimatedValue {
  setValue() {}
}
export const Animated = {
  Value: AnimatedValue,
  View: host("Animated.View"),
  spring: () => ({ start: (done?: () => void) => done?.() }),
};
/** The config is exposed as a prop so a test can drive the gesture callbacks directly. */
export const PanResponder = {
  create: (config: unknown) => ({ panHandlers: { panConfig: config } }),
};

interface CellProps {
  readonly item: unknown;
  readonly index: number;
  readonly renderItem: (info: { item: unknown; index: number }) => ReactNode;
}
class Cell extends PureComponent<CellProps> {
  override render() {
    return this.props.renderItem({ item: this.props.item, index: this.props.index });
  }
}
interface ListProps {
  readonly data: ReadonlyArray<unknown>;
  readonly extraData?: unknown;
  readonly renderItem: CellProps["renderItem"];
  readonly keyExtractor: (item: unknown, index: number) => string;
  readonly ListFooterComponent?: ReactNode;
}
export class FlatList extends PureComponent<ListProps> {
  private last: {
    renderItem: unknown;
    extraData: unknown;
    wrapped: CellProps["renderItem"];
  } | null = null;
  scrollToIndex() {}
  scrollToOffset() {}
  override render() {
    const { data, renderItem, extraData, keyExtractor, ListFooterComponent } = this.props;
    if (
      this.last === null ||
      this.last.renderItem !== renderItem ||
      this.last.extraData !== extraData
    ) {
      this.last = { renderItem, extraData, wrapped: (info) => renderItem(info) };
    }
    const wrapped = this.last.wrapped;
    return createElement(
      "FlatList",
      null,
      data.map((item, index) =>
        createElement(Cell, { key: keyExtractor(item, index), item, index, renderItem: wrapped }),
      ),
      ListFooterComponent ?? null,
    );
  }
}
