import { Container, Text } from "@ui/renderer";
import { ScaleLinear } from "d3-scale";

import { AXIS_HEIGHT, FONT_SIZE } from "../depth-chart";
import { Colors } from "../helpers";

type HorizontalAxisColors = Pick<
  Colors,
  "backgroundSurface" | "textPrimary" | "textSecondary"
>;

/**
 * Draws a horizontal axis at the bottom of the chart
 */
export class HorizontalAxis extends Container {
  /**
   * Cache ticks
   */
  private nodeByKeyValue = new Map<string, Text>();
  /**
   * Cache tick marks
   */
  private tmByKeyValue = new Map<string, Text>();


  constructor() {
    super();
  }

  public update(
    scale: ScaleLinear<number, number>,
    width: number,
    height: number,
    resolution: number = 1,
    colors: HorizontalAxisColors,
  ) {
    const numTicks = width / resolution / 200;
    const ticks = scale.ticks(numTicks);
    const tickFormat = scale.tickFormat(numTicks);

    const enter = ticks.filter(
      (tick) => !this.nodeByKeyValue.has(tickFormat(tick)),
    );

    const update = ticks.filter((tick) =>
      this.nodeByKeyValue.has(tickFormat(tick)),
    );

    const exit = [...this.nodeByKeyValue.keys()].filter(
      (node) => !(ticks.map(tickFormat).indexOf(node) !== -1),
    );

    for (const node of enter) {
      const text = new Text(tickFormat(node), {
        fill: colors.textSecondary,
        fontFamily: "monospace",
        fontSize: FONT_SIZE,
      });
      const tickMark = new Text("|", {
        fill: colors.textSecondary,
        fontFamily: "monospace",
        fontSize: 5,
      });

      text.x = scale(node);
      text.y = height - (resolution * AXIS_HEIGHT) / 2 + 5;
      text.anchor.set(0.5, 0.5);

      tickMark.x = scale(node);
      tickMark.y = height - (resolution * AXIS_HEIGHT) / 2 - 5;
      tickMark.anchor.set(0.5, 0.5);

      text.updateText(); // TODO: Should not need to call this

      this.nodeByKeyValue.set(tickFormat(node), text);
      this.tmByKeyValue.set(tickFormat(node)+"|", tickMark);
      this.addChild(text);
      this.addChild(tickMark);
    }

    for (const node of update) {
      const text = this.nodeByKeyValue.get(tickFormat(node))!;
      const tm = this.tmByKeyValue.get(tickFormat(node)+"|")!;

      text.style.fill = colors.textSecondary;
      text.x = scale(node);
      text.y = height - (resolution * AXIS_HEIGHT) / 2 + 5;

      tm.x = scale(node);
      tm.y = height - (resolution * AXIS_HEIGHT) / 2 - 5;
    }

    for (const node of exit) {
      const text = this.nodeByKeyValue.get(node)!;
      const tm = this.tmByKeyValue.get(node+"|")!;

      this.nodeByKeyValue.delete(node);
      this.removeChild(text);
      this.tmByKeyValue.delete(node);
      this.removeChild(tm);
    }
  }
}
