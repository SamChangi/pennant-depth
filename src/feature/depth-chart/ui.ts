import { HorizontalLine, Rect, VerticalLine } from "@ui/display-objects";
import {
  Container,
  InteractionData,
  InteractionEvent,
  Rectangle,
  Renderer,
} from "@ui/renderer";
import { bisectLeft, bisectRight, zip } from "d3-array";
import { Delaunay } from "d3-delaunay";
import { ScaleLinear, scaleLinear } from "d3-scale";
import EventEmitter from "eventemitter3";
import { clamp } from "lodash";

import { bisectCenter } from "../../util/math/array";
import { AXIS_HEIGHT } from "./depth-chart";
import {
  HorizontalAxis,
  Indicator,
  Label,
  MidMarketPriceLabel,
  VerticalAxis,
} from "./display-objects";
import { Colors } from "./helpers";

const OVERLAY_OPACITY = 0.05;

type UiColors = Pick<
  Colors,
  | "backgroundSurface"
  | "buyStroke"
  | "sellStroke"
  | "textPrimary"
  | "textSecondary"
  | "backgroundLabel"
  | "overlay"
>;

function pointer(event: any) {
  const node = event.target;

  const rect = node.getBoundingClientRect();

  return [
    event.clientX - rect.left - node.clientLeft,
    event.clientY - rect.top - node.clientTop,
  ];
}

function fRound(str: string) {
  str = str?.replace(/,/g, "");
  return parseFloat(str);
}

export class Gesture {
  public that: UI;
  public active: number = 0;
  public taps: number = 0;

  public touch0: any = null;
  public touch1: any = null;

  public sourceEvent: Event | null = null;

  public wheel: number | null = null;

  public zooming = false;

  constructor(that: UI) {
    this.that = that;
  }

  public start() {
    this.that.emit("zoomstart");
  }

  public zoom(scale: number) {
    this.that.emit("zoom", scale);
  }

  public end() {
    this.that.emit("zoomend");
  }
}

/**
 * Reponsible for drawing axes and handling interactivity for depth chart
 */
export class UI extends EventEmitter {
  public stage: Container = new Container();
  public renderer: Renderer;

  /**
   * The scale extent to the specified array of numbers [k0, k1] where k0 is the minimum allowed scale factor
   * and k1 is the maximum allowed scale factor.
   */
  public scaleExtent = [0, Infinity];

  public colors: UiColors;

  private prices: number[] = [];
  private volumes: number[] = [];
  private priceLabels: string[] = [];
  private numericPrices: number[] = [];
  private volumeLabels: string[] = [];
  private plotWidth: number = 0;
  private plotHeight: number = 0;
  private auctionDelaunay: Delaunay<any> | null = null;
  private priceScale: ScaleLinear<number, number> = scaleLinear();
  private volumeScale: ScaleLinear<number, number> = scaleLinear();
  private midPrice: number = 0;
  private _indicativePrice: number = 0;

  /**
   * The current scale.
   */
  public transform: number = 1;

  private horizontalAxis: HorizontalAxis = new HorizontalAxis();
  private verticalAxis: VerticalAxis = new VerticalAxis();

  private buyIndicator: Indicator;
  private sellIndicator: Indicator;
  private auctionIndicator: Indicator = new Indicator(0xcccccc);

  private buyPriceText = new Label();
  private buyVolumeText = new Label();
  private buyVolRatioText = new Label();

  private sellPriceText = new Label();
  private sellVolumeText = new Label();
  private sellVolRatioText = new Label();

  private auctionPriceText = new Label();
  private auctionVolumeText = new Label();

  private buyOverlay: Rect = new Rect(0x0, OVERLAY_OPACITY);
  private sellOverlay: Rect = new Rect(0x0, OVERLAY_OPACITY);

  private midMarketPriceLabel: MidMarketPriceLabel;
  private midPriceLine: VerticalLine = new VerticalLine(1.5, 0xdedede);

  private separator: HorizontalLine = new HorizontalLine(1, 0x494949);

  private lastEvent: InteractionEvent | null = null;

  private gesture = new Gesture(this);
  private originalTransform: number = 1;

  constructor(options: {
    view: HTMLCanvasElement;
    resolution: number;
    width: number;
    height: number;
    colors: UiColors;
  }) {
    super();

    this.renderer = new Renderer({
      view: options.view,
      resolution: options.resolution,
      width: options.width,
      height: options.height,
    });

    this.colors = options.colors;

    this.buyIndicator = new Indicator(options.colors.buyStroke);
    this.sellIndicator = new Indicator(options.colors.sellStroke);

    this.midMarketPriceLabel = new MidMarketPriceLabel(options.colors);

    const resolution = this.renderer.resolution;

    this.separator.update(
      options.height - resolution * AXIS_HEIGHT,
      options.width,
    );

    this.buyPriceText.visible = false;
    this.buyVolumeText.visible = false;
    this.buyVolRatioText.visible = false;

    this.sellPriceText.visible = false;
    this.sellVolumeText.visible = false;
    this.sellVolRatioText.visible = false;

    this.auctionPriceText.visible = false;
    this.auctionVolumeText.visible = false;

    this.stage.addChild(this.buyOverlay);
    this.stage.addChild(this.sellOverlay);
    this.stage.addChild(this.buyIndicator);
    this.stage.addChild(this.sellIndicator);
    this.stage.addChild(this.auctionIndicator);
    this.stage.addChild(this.horizontalAxis);
    this.stage.addChild(this.verticalAxis);
    this.stage.addChild(this.midPriceLine);
    // this.stage.addChild(this.midMarketPriceLabel);
    this.stage.addChild(this.buyPriceText);
    this.stage.addChild(this.buyVolumeText);
    this.stage.addChild(this.buyVolRatioText);
    this.stage.addChild(this.sellPriceText);
    this.stage.addChild(this.sellVolumeText);
    this.stage.addChild(this.sellVolRatioText);
    this.stage.addChild(this.auctionPriceText);
    this.stage.addChild(this.auctionVolumeText);
    // this.stage.addChild(this.separator);

    this.stage.interactive = true;
    this.stage.hitArea = new Rectangle(0, 0, options.width, options.height);

    this.stage
      .on("wheel", (event: InteractionEvent) => {
        const tempEvent = event.data?.originalEvent as WheelEvent;

        if (this.gesture.wheel) {
          window.clearTimeout(this.gesture.wheel);
        } else {
          this.gesture.start();
        }

        const k = Math.pow(
          2,
          -tempEvent.deltaY * 0.002 * (tempEvent.ctrlKey ? 10 : 1),
        );

        this.transform = clamp(
          this.transform * k,
          this.scaleExtent[0],
          this.scaleExtent[1],
        );

        this.gesture.wheel = window.setTimeout(() => {
          this.gesture.wheel = null;
          this.gesture.end();
        }, 150);

        this.emit("zoom", this.transform);
      })
      .on("touchstart", (event) => {
        if (event.data.originalEvent instanceof TouchEvent) {
          const originalEvent = event.data.originalEvent;

          const touches = originalEvent.touches;
          let started = false;

          originalEvent.stopImmediatePropagation();

          for (const touch of touches) {
            const p = pointer(touch);

            if (!this.gesture.touch0) {
              this.gesture.touch0 = {
                point: p,
                originalPoint: p,
                identifier: touch.identifier,
              };

              started = true;
            } else if (
              !this.gesture.touch1 &&
              this.gesture.touch0.identifier !== touch.identifier
            ) {
              this.gesture.touch1 = {
                point: p,
                originalPoint: p,
                identifier: touch.identifier,
              };

              this.gesture.taps = 0;
            }
          }

          if (started) {
            this.originalTransform = this.transform;
            this.gesture.start();
          }
        }
      })
      .on("touchmove", (event) => {
        if (event.data.originalEvent instanceof TouchEvent) {
          event.data.originalEvent.preventDefault();
          event.data.originalEvent.stopImmediatePropagation();

          const touches = event.data.originalEvent.changedTouches ?? [];

          for (const touch of touches) {
            if (
              this.gesture.touch0 &&
              this.gesture.touch0.identifier === touch.identifier
            ) {
              this.gesture.touch0.point = pointer(touch);
            } else if (
              this.gesture.touch1 &&
              this.gesture.touch1.identifier === touch.identifier
            ) {
              this.gesture.touch1.point = pointer(touch);
            }
          }

          if (this.gesture.touch1) {
            const p0 = this.gesture.touch0.point;
            const p1 = this.gesture.touch1.point;

            const l0 = this.gesture.touch0.originalPoint;
            const l1 = this.gesture.touch1.originalPoint;

            const dp = (p1[0] - p0[0]) ** 2 + (p1[1] - p0[1]) ** 2;
            const dl = (l1[0] - l0[0]) ** 2 + (l1[1] - l0[1]) ** 2;

            const k = Math.sqrt(dp / dl);

            this.transform = clamp(
              this.originalTransform * k,
              this.scaleExtent[0],
              this.scaleExtent[1],
            );

            this.gesture.zoom(
              clamp(this.transform, this.scaleExtent[0], this.scaleExtent[1]),
            );
          }
        }
      })
      .on("touchend", (event) => {
        if (event.data.originalEvent instanceof TouchEvent) {
          const touches = event.data.originalEvent.changedTouches ?? [];

          for (const touch of touches) {
            if (
              this.gesture.touch0 &&
              this.gesture.touch0.identifier === touch.identifier
            ) {
              this.gesture.touch0 = null;
            } else if (
              this.gesture.touch1 &&
              this.gesture.touch1.identifier === touch.identifier
            ) {
              this.gesture.touch1 = null;
            }
          }

          if (this.gesture.touch1 && !this.gesture.touch0) {
            this.gesture.touch0 = null;
            this.gesture.touch1 = null;
          }

          this.gesture.end();
        }
      })
      .on("pointermove", this.onPointerMove)
      .on("pointerout", this.onPointerOut)
      .on("pointerdown", this.onPointerDown);
  }

  public render(): void {
    this.renderer.render(this.stage);
  }

  public update(
    width: number,
    height: number,
    prices: number[],
    volumes: number[],
    midPrice: number,
    priceLabels: string[],
    volumeLabels: string[],
    midPriceLabel: string,
    midPriceTitle: string,
    priceScale: ScaleLinear<number, number>,
    volumeScale: ScaleLinear<number, number>,
    domain: [number, number],
  ): void {
    this.plotWidth = width;
    this.plotHeight = height;
    this.prices = prices;
    this.volumes = volumes;
    this.midPrice = midPrice;
    this.priceLabels = priceLabels;
    this.numericPrices = priceLabels.map((price) => fRound(price));
    this.volumeLabels = volumeLabels;
    this.priceScale = priceScale;
    this.volumeScale = volumeScale;

    this.auctionDelaunay =
      this._indicativePrice && this.prices.length > 1
        ? Delaunay.from(
            zip<number>(this.prices, this.volumes) as [number, number][],
          )
        : null;

    const resolution = this.renderer.resolution;
    // const height = this.renderer.view.height;
    // const width = this.renderer.view.width;

    // const numTicks = height / resolution / 50;
    // const ticks = volumeScale.ticks(numTicks).filter((tick) => tick !== 0);
    // const length = ticks[ticks.length - 1]?.toLocaleString().length;
    // const width = this.renderer.view.width - 5 * length - 15;

    this.horizontalAxis.update(
      this.priceScale,
      width,
      height,
      resolution,
      this.colors,
      domain,
    );

    this.verticalAxis.update(
      volumeScale,
      width,
      height,
      resolution,
      this.colors,
    );

    this.midMarketPriceLabel.update(
      // (width-30) / 2,
      width / 2,
      10,
      {
        x: 0.5,
        y: 0,
      },
      resolution,
      this.colors,
      midPriceLabel,
      midPriceTitle,
    );

    // this.midPriceLine.update((width-30) / 2, height, resolution);
    // this.separator.update(height - resolution * AXIS_HEIGHT, width - 30);
    this.midPriceLine.update(width / 2, height, resolution);
    this.separator.update(height - resolution * AXIS_HEIGHT, width);

    this.stage.hitArea = new Rectangle(
      0,
      0,
      this.renderer.screen.width,
      this.renderer.screen.height,
    );

    if (this.lastEvent) {
      this.onPointerMove(this.lastEvent);
      this.onPointerDown(this.lastEvent);
    }
  }

  public updatePrice(price: number) {
    const event = new InteractionEvent();
    event.data = new InteractionData();
    event.data.global.x = this.priceScale(price);

    this.onPointerMove(event);
    this.onPointerDown(event);
  }

  public clearPrice() {
    this.onPointerOut();
  }

  private onPointerMove = (event: InteractionEvent) => {
    if ("ontouchstart" in self) return;

    this.lastEvent = event;

    let x = event.data?.global.x;

    if (x && this.prices.length > 1) {
      const resolution = this.renderer.resolution;
      x *= resolution;
      const width = this.plotWidth || this.renderer.view.width;
      const height = this.plotHeight || this.renderer.view.height;

      // In auction mode. Curves will in general overlap
      // so use different tooltip behaviour
      if (this._indicativePrice) {
        const y = (event.data?.global.y as number) * resolution;
        const radius = 50 * resolution;

        const delaunay = this.auctionDelaunay;

        if (!delaunay) {
          this.auctionPriceText.visible = false;
          this.auctionVolumeText.visible = false;
          this.auctionIndicator.visible = false;
          this.render();
          return;
        }

        const index = delaunay.find(x, y);

        const d = Math.hypot(x - this.prices[index], y - this.volumes[index]);

        if (d < radius) {
          this.auctionPriceText.update(
            this.priceLabels[index],
            Math.max(
              Math.min(
                this.prices[index],
                width - (resolution * this.auctionPriceText.width) / 2 - 2,
              ),
              width / 2 +
                (resolution * this.sellPriceText.width) / 2 +
                resolution * 2,
            ),
            height - (resolution * AXIS_HEIGHT) / 2,
            { x: 0.5, y: 0.5 },
            resolution,
            this.colors,
          );

          this.auctionVolumeText.update(
            this.volumeLabels[index],
            this.prices[index] > width / 2
              ? this.prices[index] - width / 2 >
                resolution * this.auctionVolumeText.width + resolution * 6
                ? width / 2 + resolution * 3
                : this.prices[index] + 6
              : width / 2 - this.prices[index] >
                resolution * this.auctionVolumeText.width + 6
              ? width / 2 - resolution * 2
              : this.prices[index] - 6,
            Math.min(
              Math.max(
                this.volumes[index],
                this.auctionVolumeText.height / 2 + 2,
              ),
              height -
                resolution * AXIS_HEIGHT -
                this.auctionVolumeText.height / 2 -
                2,
            ),
            { x: this.prices[index] > width / 2 ? 0 : 1, y: 0.5 },
            resolution,
            this.colors,
          );

          this.auctionIndicator.update(
            this.prices[index],
            this.volumes[index],
            width,
            height,
          );

          this.auctionPriceText.visible = true;
          this.auctionVolumeText.visible = true;
          this.auctionIndicator.visible = true;
        } else {
          this.auctionPriceText.visible = false;
          this.auctionVolumeText.visible = false;
          this.auctionIndicator.visible = false;
        }
      } else {
        const index = bisectCenter(this.prices, x);
        const nearestX = this.prices[index];

        let buyIndex: number;
        let sellIndex: number;
        let buyNearestX: number;
        let sellNearestX: number;

        if (x > width / 2) {
          buyIndex =
            this.prices[0] >= width / 2
              ? -1
              : bisectLeft(
                  this.prices,
                  2 * this.priceScale(this.midPrice) - nearestX,
                ) - 1;

          sellIndex = index;

          buyNearestX = 2 * this.priceScale(this.midPrice) - nearestX;
          sellNearestX = nearestX;
        } else {
          buyIndex = index;

          sellIndex =
            this.prices[this.prices.length - 1] <= width / 2
              ? -1
              : bisectRight(
                  this.prices,
                  2 * this.priceScale(this.midPrice) - nearestX,
                ) - 1;

          buyNearestX = nearestX;
          sellNearestX = 2 * this.priceScale(this.midPrice) - nearestX;
        }

        // console.log('priceLabels [index]: ', this.priceLabels[buyIndex]);
        this.buyVolRatioText.update(
          (
            ((this.numericPrices[buyIndex] - this.midPrice) / this.midPrice) *
            100
          ).toFixed(2) + "%",
          // width / 2 - buyNearestX > resolution * this.buyVolRatioText.width + 6
          //   ? width / 2 - resolution * 2
          //   : buyNearestX - 6,
          buyNearestX +
            (width / 2 - buyNearestX) / 2 +
            (resolution * this.buyVolRatioText.width) / 2,
          Math.min(
            Math.max(
              this.volumes[buyIndex],
              (resolution * this.buyVolRatioText.height) / 2 + 2,
            ),
            height -
              resolution * AXIS_HEIGHT -
              (resolution * this.buyVolRatioText.height) / 2 -
              2,
          ),
          { x: 1, y: 0.5 },
          resolution,
          this.colors,
        );

        this.buyPriceText.update(
          this.priceLabels[buyIndex],
          Math.min(
            Math.max(
              buyNearestX,
              (resolution * this.buyPriceText.width) / 2 + 2,
            ),
            width / 2 -
              (resolution * this.buyPriceText.width) / 2 -
              resolution * 2,
          ),
          height - (resolution * AXIS_HEIGHT) / 2 + 3 * resolution,
          { x: 0.5, y: 0.5 },
          resolution,
          this.colors,
        );
        // console.log(this.volumeLabels[buyIndex]);
        this.buyVolumeText.update(
          this.volumeLabels[buyIndex],
          0,
          Math.min(
            Math.max(
              this.volumes[buyIndex],
              (resolution * this.buyVolumeText.height) / 2 + 2,
            ),
            height -
              resolution * AXIS_HEIGHT -
              (resolution * this.buyVolumeText.height) / 2 -
              2,
          ),
          { x: 0, y: 0.5 },
          resolution,
          this.colors,
        );

        this.sellVolRatioText.update(
          "+" +
            (
              ((this.numericPrices[sellIndex] - this.midPrice) /
                this.midPrice) *
              100
            ).toFixed(2) +
            "%",
          // sellNearestX - width / 2 > resolution * this.sellVolRatioText.width + 6
          //   ? width / 2 + resolution * 3
          //   : sellNearestX + 6,
          width / 2 +
            (sellNearestX - width / 2) / 2 -
            (resolution * this.sellVolRatioText.width) / 2,
          Math.min(
            Math.max(
              this.volumes[sellIndex],
              (resolution * this.sellVolRatioText.height) / 2 + 2,
            ),
            height -
              resolution * AXIS_HEIGHT -
              (resolution * this.sellVolRatioText.height) / 2 -
              2,
          ),
          { x: 0, y: 0.5 },
          resolution,
          this.colors,
          "sell",
        );

        this.sellPriceText.update(
          this.priceLabels[sellIndex],
          Math.max(
            Math.min(
              sellNearestX,
              width - (resolution * this.sellPriceText.width) / 2 - 2,
            ),
            width / 2 +
              (resolution * this.sellPriceText.width) / 2 +
              resolution * 2,
          ),
          height - (resolution * AXIS_HEIGHT) / 2 + 3 * resolution,
          { x: 0.5, y: 0.5 },
          resolution,
          this.colors,
          "sell",
        );

        this.sellVolumeText.update(
          this.volumeLabels[sellIndex],
          width,
          Math.min(
            Math.max(
              this.volumes[sellIndex],
              (resolution * this.sellVolumeText.height) / 2 + 2,
            ),
            height -
              resolution * AXIS_HEIGHT -
              (resolution * this.sellVolumeText.height) / 2 -
              2,
          ),
          { x: 1, y: 0.5 },
          resolution,
          this.colors,
          "sell",
        );

        const sellPricesPresent =
          this.prices[this.prices.length - 1] > width / 2;

        const buyPricesPresent = this.prices[0] < width / 2;

        // this.buyIndicator.update(buyNearestX, this.volumes[buyIndex], width-30, height);
        this.buyIndicator.update(
          buyNearestX,
          this.volumes[buyIndex],
          width,
          height,
        );
        // this.sellIndicator.update(sellNearestX, this.volumes[sellIndex], width-30, height, 'sell');
        this.sellIndicator.update(
          sellNearestX,
          this.volumes[sellIndex],
          width,
          height,
          "sell",
        );

        this.buyOverlay.update(
          0,
          0,
          buyNearestX,
          height - resolution * AXIS_HEIGHT,
          this.colors.overlay,
        );

        this.sellOverlay.update(
          sellNearestX,
          0,
          // width - sellNearestX - 30,
          width - sellNearestX,
          height - resolution * AXIS_HEIGHT,
          this.colors.overlay,
        );

        // TODO: Changing visibility in groups like this suggests they should be in a Container
        if (
          this.priceScale.invert(buyNearestX) > this.priceScale.domain()[0] &&
          buyPricesPresent &&
          buyIndex !== -1
        ) {
          this.buyPriceText.visible = true;
          this.buyVolumeText.visible = true;
          this.buyVolRatioText.visible = true;
          this.buyIndicator.visible = true;
          this.buyOverlay.visible = true;
        } else {
          this.buyPriceText.visible = false;
          this.buyVolumeText.visible = false;
          this.buyVolRatioText.visible = false;
          this.buyIndicator.visible = false;
          this.buyOverlay.visible = false;
        }

        if (
          this.priceScale.invert(sellNearestX) < this.priceScale.domain()[1] &&
          sellPricesPresent &&
          sellIndex !== -1
        ) {
          this.sellPriceText.visible = true;
          this.sellVolumeText.visible = true;
          this.sellVolRatioText.visible = true;
          this.sellIndicator.visible = true;
          this.sellOverlay.visible = true;
        } else {
          this.sellPriceText.visible = false;
          this.sellVolumeText.visible = false;
          this.sellVolRatioText.visible = false;
          this.sellIndicator.visible = false;
          this.sellOverlay.visible = false;
        }
      }

      this.render();
    }
  };

  public destroy() {
    this.stage.destroy();

    this.renderer.destroy();
  }

  private onPointerOut = () => {
    this.buyPriceText.visible = false;
    this.buyVolumeText.visible = false;
    this.buyVolRatioText.visible = false;
    this.sellPriceText.visible = false;
    this.sellVolumeText.visible = false;
    this.sellVolRatioText.visible = false;

    this.buyIndicator.visible = false;
    this.sellIndicator.visible = false;

    this.buyOverlay.visible = false;
    this.sellOverlay.visible = false;

    this.lastEvent = null;

    this.render();
  };

  private onPointerDown = (event: InteractionEvent) => {
    // let x = event.data?.global.x;
    if (!("ontouchstart" in self)) return;
    this.lastEvent = event;

    let x = event.data?.global.x;

    if (x && this.prices.length > 1) {
      const resolution = this.renderer.resolution;
      x *= resolution;
      const width = this.plotWidth || this.renderer.view.width;
      const height = this.plotHeight || this.renderer.view.height;

      // In auction mode. Curves will in general overlap
      // so use different tooltip behaviour
      if (this._indicativePrice) {
        const y = (event.data?.global.y as number) * resolution;
        const radius = 50 * resolution;

        const delaunay = this.auctionDelaunay;

        if (!delaunay) {
          this.auctionPriceText.visible = false;
          this.auctionVolumeText.visible = false;
          this.auctionIndicator.visible = false;
          this.render();
          return;
        }

        const index = delaunay.find(x, y);

        const d = Math.hypot(x - this.prices[index], y - this.volumes[index]);

        if (d < radius) {
          this.auctionPriceText.update(
            this.priceLabels[index],
            Math.max(
              Math.min(
                this.prices[index],
                width - (resolution * this.auctionPriceText.width) / 2 - 2,
              ),
              width / 2 +
                (resolution * this.sellPriceText.width) / 2 +
                resolution * 2,
            ),
            height - (resolution * AXIS_HEIGHT) / 2,
            { x: 0.5, y: 0.5 },
            resolution,
            this.colors,
          );

          this.auctionVolumeText.update(
            this.volumeLabels[index],
            this.prices[index] > width / 2
              ? this.prices[index] - width / 2 >
                resolution * this.auctionVolumeText.width + resolution * 6
                ? width / 2 + resolution * 3
                : this.prices[index] + 6
              : width / 2 - this.prices[index] >
                resolution * this.auctionVolumeText.width + 6
              ? width / 2 - resolution * 2
              : this.prices[index] - 6,
            Math.min(
              Math.max(
                this.volumes[index],
                this.auctionVolumeText.height / 2 + 2,
              ),
              height -
                resolution * AXIS_HEIGHT -
                this.auctionVolumeText.height / 2 -
                2,
            ),
            { x: this.prices[index] > width / 2 ? 0 : 1, y: 0.5 },
            resolution,
            this.colors,
          );

          this.auctionIndicator.update(
            this.prices[index],
            this.volumes[index],
            width,
            height,
          );

          this.auctionPriceText.visible = true;
          this.auctionVolumeText.visible = true;
          this.auctionIndicator.visible = true;
        } else {
          this.auctionPriceText.visible = false;
          this.auctionVolumeText.visible = false;
          this.auctionIndicator.visible = false;
        }
      } else {
        const index = bisectCenter(this.prices, x);
        const nearestX = this.prices[index];

        let buyIndex: number;
        let sellIndex: number;
        let buyNearestX: number;
        let sellNearestX: number;

        if (x > width / 2) {
          buyIndex =
            this.prices[0] >= width / 2
              ? -1
              : bisectLeft(
                  this.prices,
                  2 * this.priceScale(this.midPrice) - nearestX,
                ) - 1;

          sellIndex = index;

          buyNearestX = 2 * this.priceScale(this.midPrice) - nearestX;
          sellNearestX = nearestX;
        } else {
          buyIndex = index;

          sellIndex =
            this.prices[this.prices.length - 1] <= width / 2
              ? -1
              : bisectRight(
                  this.prices,
                  2 * this.priceScale(this.midPrice) - nearestX,
                ) - 1;

          buyNearestX = nearestX;
          sellNearestX = 2 * this.priceScale(this.midPrice) - nearestX;
        }

        // console.log('priceLabels [index]: ', this.priceLabels[buyIndex]);
        this.buyVolRatioText.update(
          (
            ((this.numericPrices[buyIndex] - this.midPrice) / this.midPrice) *
            100
          ).toFixed(2) + "%",
          // width / 2 - buyNearestX > resolution * this.buyVolRatioText.width + 6
          //   ? width / 2 - resolution * 2
          //   : buyNearestX - 6,
          buyNearestX +
            (width / 2 - buyNearestX) / 2 +
            (resolution * this.buyVolRatioText.width) / 2,
          Math.min(
            Math.max(
              this.volumes[buyIndex],
              (resolution * this.buyVolRatioText.height) / 2 + 2,
            ),
            height -
              resolution * AXIS_HEIGHT -
              (resolution * this.buyVolRatioText.height) / 2 -
              2,
          ),
          { x: 1, y: 0.5 },
          resolution,
          this.colors,
        );

        this.buyPriceText.update(
          this.priceLabels[buyIndex],
          Math.min(
            Math.max(
              buyNearestX,
              (resolution * this.buyPriceText.width) / 2 + 2,
            ),
            width / 2 -
              (resolution * this.buyPriceText.width) / 2 -
              resolution * 2,
          ),
          height - (resolution * AXIS_HEIGHT) / 2 + 3 * resolution,
          { x: 0.5, y: 0.5 },
          resolution,
          this.colors,
        );
        // console.log(this.volumeLabels[buyIndex]);
        this.buyVolumeText.update(
          this.volumeLabels[buyIndex],
          0,
          Math.min(
            Math.max(
              this.volumes[buyIndex],
              (resolution * this.buyVolumeText.height) / 2 + 2,
            ),
            height -
              resolution * AXIS_HEIGHT -
              (resolution * this.buyVolumeText.height) / 2 -
              2,
          ),
          { x: 0, y: 0.5 },
          resolution,
          this.colors,
        );

        this.sellVolRatioText.update(
          "+" +
            (
              ((this.numericPrices[sellIndex] - this.midPrice) /
                this.midPrice) *
              100
            ).toFixed(2) +
            "%",
          // sellNearestX - width / 2 > resolution * this.sellVolRatioText.width + 6
          //   ? width / 2 + resolution * 3
          //   : sellNearestX + 6,
          width / 2 +
            (sellNearestX - width / 2) / 2 -
            (resolution * this.sellVolRatioText.width) / 2,
          Math.min(
            Math.max(
              this.volumes[sellIndex],
              (resolution * this.sellVolRatioText.height) / 2 + 2,
            ),
            height -
              resolution * AXIS_HEIGHT -
              (resolution * this.sellVolRatioText.height) / 2 -
              2,
          ),
          { x: 0, y: 0.5 },
          resolution,
          this.colors,
          "sell",
        );

        this.sellPriceText.update(
          this.priceLabels[sellIndex],
          Math.max(
            Math.min(
              sellNearestX,
              width - (resolution * this.sellPriceText.width) / 2 - 2,
            ),
            width / 2 +
              (resolution * this.sellPriceText.width) / 2 +
              resolution * 2,
          ),
          height - (resolution * AXIS_HEIGHT) / 2 + 3 * resolution,
          { x: 0.5, y: 0.5 },
          resolution,
          this.colors,
          "sell",
        );

        this.sellVolumeText.update(
          this.volumeLabels[sellIndex],
          width,
          Math.min(
            Math.max(
              this.volumes[sellIndex],
              (resolution * this.sellVolumeText.height) / 2 + 2,
            ),
            height -
              resolution * AXIS_HEIGHT -
              (resolution * this.sellVolumeText.height) / 2 -
              2,
          ),
          { x: 1, y: 0.5 },
          resolution,
          this.colors,
          "sell",
        );

        const sellPricesPresent =
          this.prices[this.prices.length - 1] > width / 2;

        const buyPricesPresent = this.prices[0] < width / 2;

        // this.buyIndicator.update(buyNearestX, this.volumes[buyIndex], width-30, height);
        this.buyIndicator.update(
          buyNearestX,
          this.volumes[buyIndex],
          width,
          height,
        );
        // this.sellIndicator.update(sellNearestX, this.volumes[sellIndex], width-30, height, 'sell');
        this.sellIndicator.update(
          sellNearestX,
          this.volumes[sellIndex],
          width,
          height,
          "sell",
        );

        this.buyOverlay.update(
          0,
          0,
          buyNearestX,
          height - resolution * AXIS_HEIGHT,
          this.colors.overlay,
        );

        this.sellOverlay.update(
          sellNearestX,
          0,
          // width - sellNearestX - 30,
          width - sellNearestX,
          height - resolution * AXIS_HEIGHT,
          this.colors.overlay,
        );

        // TODO: Changing visibility in groups like this suggests they should be in a Container
        if (
          this.priceScale.invert(buyNearestX) > this.priceScale.domain()[0] &&
          buyPricesPresent &&
          buyIndex !== -1
        ) {
          this.buyPriceText.visible = true;
          this.buyVolumeText.visible = true;
          this.buyVolRatioText.visible = true;
          this.buyIndicator.visible = true;
          this.buyOverlay.visible = true;
        } else {
          this.buyPriceText.visible = false;
          this.buyVolumeText.visible = false;
          this.buyVolRatioText.visible = false;
          this.buyIndicator.visible = false;
          this.buyOverlay.visible = false;
        }

        if (
          this.priceScale.invert(sellNearestX) < this.priceScale.domain()[1] &&
          sellPricesPresent &&
          sellIndex !== -1
        ) {
          this.sellPriceText.visible = true;
          this.sellVolumeText.visible = true;
          this.sellVolRatioText.visible = true;
          this.sellIndicator.visible = true;
          this.sellOverlay.visible = true;
        } else {
          this.sellPriceText.visible = false;
          this.sellVolumeText.visible = false;
          this.sellVolRatioText.visible = false;
          this.sellIndicator.visible = false;
          this.sellOverlay.visible = false;
        }
      }

      this.render();
    }
  };

  set indicativePrice(price: number) {
    this._indicativePrice = price;
  }
}
