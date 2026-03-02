import { extent, max, mean, min } from "d3-array";
import { ScaleLinear, scaleLinear } from "d3-scale";
import EventEmitter from "eventemitter3";
import { fill, orderBy, sortBy, zip } from "lodash";

import cumsum, { getFloatNumber } from "../../util/math/array/cumsum";
import { Contents } from "./contents";
import { AXIS_HEIGHT, PriceLevel } from "./depth-chart";
import { Colors, Dimensions } from "./helpers";
import { UI } from "./ui";

function getMidPrice(
  indicativePrice: number,
  midPrice: number,
  buyPrice: number,
  sellPrice: number,
): number {
  if (indicativePrice) {
    return indicativePrice;
  }

  if (midPrice) {
    return midPrice;
  }

  return mean([buyPrice, sellPrice]) as number;
}

// Ratio of price percentage change to volume percentage change used to detect outliers
const PRICE_VOLUME_RATIO_THRESHOLD = 100; // 价量比阈值, 用于检测异常值的价格百分比变化与成交量百分比变化之比

export class Chart extends EventEmitter {
  private chart: Contents;
  public axis: UI;

  private cumulativeBuy: [number, number][] = [];
  private cumulativeSell: [number, number][] = [];
  private prices: number[] = [];
  private volumes: number[] = [];
  private priceLabels: string[] = [];
  private volumeLabels: string[] = [];
  private frameId: number | null = null;
  private dirty = false;

  private _span: number = 1;
  private initialSpan: number = 1;
  private maxPriceDifference: number = 0;
  private initialPriceDifference: number = 0;
  private _data: { buy: PriceLevel[]; sell: PriceLevel[] } = {
    buy: [],
    sell: [],
  };
  private _fillAlpha: number = 0.2;

  /** Indicative price if the auction ended now, 0 if not in auction mode */
  private _indicativePrice: number = 0;

  /** Arithmetic average of the best bid price and best offer price. */
  private _midPrice: number = 0;

  priceFormat: (price: number) => string;
  volumeFormat: (volume: number) => string;

  private _colors: Colors;
  private _dimensions: Dimensions;

  constructor(options: {
    chartView: HTMLCanvasElement;
    axisView: HTMLCanvasElement;
    resolution: number;
    width: number;
    height: number;
    priceFormat: (price: number) => string;
    volumeFormat: (volume: number) => string;
    colors: Colors;
    dimensions: Dimensions;
    fillAlpha?: number;
  }) {
    super();

    this.priceFormat = options.priceFormat;
    this.volumeFormat = options.volumeFormat;
    this._colors = options.colors;
    this._dimensions = options.dimensions;
    this._fillAlpha = options.fillAlpha ?? 0.2;

    this.chart = new Contents({
      view: options.chartView,
      resolution: options.resolution,
      width: options.width,
      height: options.height,
      colors: options.colors,
      dimensions: options.dimensions,
    });

    this.axis = new UI({
      view: options.axisView,
      resolution: options.resolution,
      width: options.width,
      height: options.height,
      colors: options.colors,
    });

    this.axis
      .on("zoomstart", () => {
        this.emit("zoomstart");
      })
      .on("zoom", (k: number) => {
        this.span = this.initialSpan / k;
        this.emit("zoom");
      })
      .on("zoomend", () => {
        this.emit("zoomend");
      });
  }

  public updatePrice(price: number) {
    this.axis.updatePrice(price);
  }

  public clearPrice() {
    this.axis.clearPrice();
  }

  public render() {
    this.chart.render();
    this.axis.render();
  }

  public resize(width: number, height: number) {
    // const numTicks = height / 50;
    // const ticks = this.volumeScale.ticks(numTicks).filter((tick) => tick !== 0);
    // const length = ticks[ticks.length - 1]?.toLocaleString().length;
    // {length: 5, width: 40, yA: 45}
    // {length: 4, width: 35, yA: 40}
    // {length: 3, width: 30, yA: 35}
    // {length: 2, width: 25, yA: 30}
    // {length: 1, width: 20, yA: 25}
    // {n     5n+15      5n+20}
    // this.chart.renderer.resize(width - 5 * length - 15, height);
    this.chart.renderer.resize(width, height);
    this.axis.renderer.resize(width, height);
    this.invalidate();
  }

  public destroy() {
    if (this.frameId !== null) {
      window.cancelAnimationFrame(this.frameId);
      this.frameId = null;
    }
    this.axis.destroy();
  }

  private invalidate() {
    this.dirty = true;

    if (this.frameId !== null) {
      return;
    }

    this.frameId = window.requestAnimationFrame(() => {
      this.frameId = null;

      if (!this.dirty) {
        return;
      }

      this.dirty = false;
      this.update();
      this.render();
    });
  }

  private update() {
    const resolution = this.axis.renderer.resolution;

    const cumulativeBuy = this.cumulativeBuy;
    const cumulativeSell = this.cumulativeSell;

    const midPrice = getMidPrice(
      this._indicativePrice,
      this._midPrice,
      this._data.buy?.[0]?.price,
      this._data.sell?.[0]?.price,
    );

    this.maxPriceDifference =
      max(this.prices.map((price) => Math.abs(price - midPrice))) ?? 0;

    if (!this.initialPriceDifference) {
      // Remove outliers
      const buyPriceLevels = orderBy(this._data.buy, ["price"]);
      const sellPriceLevels = orderBy(this._data.sell, ["price"]);

      while (buyPriceLevels.length > 2) {
        if (
          Math.abs(
            (buyPriceLevels[0].price - buyPriceLevels[1].price) /
              (buyPriceLevels[0].price - midPrice),
          ) /
            (buyPriceLevels[0].volume /
              cumulativeBuy[cumulativeBuy.length - 1][1]) >
          PRICE_VOLUME_RATIO_THRESHOLD
        ) {
          buyPriceLevels.splice(0, 1);
        } else {
          break;
        }
      }

      while (sellPriceLevels.length > 2) {
        const maxIndex = sellPriceLevels.length - 1;

        if (
          Math.abs(
            (sellPriceLevels[maxIndex].price -
              sellPriceLevels[maxIndex - 1].price) /
              (sellPriceLevels[maxIndex].price - midPrice),
          ) /
            (sellPriceLevels[maxIndex].volume /
              cumulativeSell[cumulativeSell.length - 1][1]) >
          PRICE_VOLUME_RATIO_THRESHOLD
        ) {
          sellPriceLevels.splice(-1, 1);
        } else {
          break;
        }
      }

      this.initialPriceDifference =
        max(
          [...buyPriceLevels, ...sellPriceLevels].map((priceLevel) =>
            Math.abs(priceLevel.price - midPrice),
          ),
        ) ?? 0;
      this.initialSpan = 1;
      // this.initialSpan = this.initialPriceDifference / this.maxPriceDifference;
      // this._span = this.initialSpan;
    }

    const priceExtent: [number, number] = [
      midPrice - this._span * this.maxPriceDifference,
      midPrice + this._span * this.maxPriceDifference,
    ];

    const indexExtent = extent(
      orderBy([...this._data.buy, ...this._data.sell], ["price"])
        .map((priceLevel, index) => ({ ...priceLevel, index }))
        .filter(
          (priceLevel) =>
            priceLevel.price >= priceExtent[0] &&
            priceLevel.price <= priceExtent[1],
        )
        .map((priceLevel) => priceLevel.index),
    );

    const volumeExtent: [number, number] = [
      0,
      1.2 * (max(this.volumes.slice(indexExtent[0], indexExtent[1])) ?? 0),
    ];

    const volumeScale = scaleLinear()
      .domain(volumeExtent)
      .range([this.height - resolution * AXIS_HEIGHT, 0]);

    const numTicks = this.height / resolution / 50;
    let ticks = volumeScale.ticks(numTicks);
    let flag: boolean = false;
    if (ticks.every((el) => el === 0)) {
      flag = true;
    }
    // const lgNumber = ticks[ticks.length - 1];
    const formatTicks = ticks.map((num) => {
      let numStr = "";
      if (num >= 1000) {
        numStr = Intl.NumberFormat("en-US", {
          notation: "compact",
          maximumFractionDigits: 2,
          minimumFractionDigits: 2,
        }).format(num);
      } else {
        const precision = getFloatNumber(num);
        numStr = num.toLocaleString("en-US", {
          maximumFractionDigits: precision,
          minimumFractionDigits: precision,
        });
      }
      return numStr;
    });
    const descFmtStrs = formatTicks.sort((a, b) => b.length - a.length);
    // console.log("**VOLUME**", formatTicks[formatTicks.length - 1]);
    // console.log("**precs**", precision);
    // console.log('**KM**', formatTicks[formatTicks.length - 1]?.length);
    const size = descFmtStrs[0]?.length + 0.8;
    // console.log("==size==", size);
    const priceScale = scaleLinear()
      .domain(priceExtent)
      .range([0, this.width - resolution * 8 * size]);

    // Add dummy data points at extreme points of price range
    // to ensure the chart looks symmetric
    const buyCurvePoints = [...cumulativeBuy];
    const sellCurvePoints = [...cumulativeSell];

    if (buyCurvePoints.length > 0) {
      buyCurvePoints.push([
        midPrice - this.maxPriceDifference,
        buyCurvePoints[buyCurvePoints.length - 1][1],
      ]);
    }

    if (sellCurvePoints.length > 0) {
      sellCurvePoints.push([
        midPrice + this.maxPriceDifference,
        sellCurvePoints[sellCurvePoints.length - 1][1],
      ]);
    }

    this.chart.colors = this._colors;
    this.chart.dimensions = this._dimensions;
    this.chart.update(
      buyCurvePoints.map((point) => [
        priceScale(point[0]),
        flag ? this.height - resolution * AXIS_HEIGHT : volumeScale(point[1]),
      ]),
      sellCurvePoints.map((point) => [
        priceScale(point[0]),
        flag ? this.height - resolution * AXIS_HEIGHT : volumeScale(point[1]),
      ]),
      resolution * 8 * size,
      this._fillAlpha,
    );

    // TODO: Clean up this logic
    if (this._data.buy.length > 0 && this._data.sell.length > 0) {
      const minExtent =
        (min(
          this.prices
            .filter((price) => midPrice - price > 0)
            .map((price) => midPrice - price),
        ) as number) ??
        0 +
          (min(
            this.prices
              .filter((price) => price - midPrice > 0)
              .map((price) => price - midPrice),
          ) as number) ??
        0;

      this.axis.scaleExtent = [
        this.initialSpan,
        this.maxPriceDifference /
          (2 * (minExtent ?? this.maxPriceDifference / 10)),
      ];
    }

    this.axis.colors = this._colors;

    this.axis.update(
      this.width - resolution * 8 * size,
      this.height,
      this.prices.map((price) => priceScale(price)),
      this.volumes.map((volume) =>
        flag ? this.height - resolution * AXIS_HEIGHT : volumeScale(volume),
      ),
      midPrice,
      this.priceLabels,
      this.volumeLabels,
      this.priceFormat(midPrice),
      this._indicativePrice > 0 ? "Indicative price" : "Mid Market Price",
      priceScale,
      volumeScale,
      priceExtent,
    );

    // console.log(
    //   this.width - 16 * size,
    //   this.height,
    //   this.prices.map((price) => priceScale(price)),
    //   this.volumes.map((volume) =>
    //     flag ? this.height - resolution * AXIS_HEIGHT : volumeScale(volume),
    //   ),
    //   midPrice,
    //   this.priceLabels,
    //   this.volumeLabels,
    //   this.priceFormat(midPrice),
    //   this._indicativePrice > 0 ? "Indicative price" : "Mid Market Price",
    //   priceScale,
    //   volumeScale,
    // );
  }

  set colors(colors: Colors) {
    this._colors = colors;
    this.invalidate();
  }

  set dimensions(dimensions: Dimensions) {
    this._dimensions = dimensions;
    this.invalidate();
  }

  get data() {
    return this._data;
  }

  set data(data: { buy: PriceLevel[]; sell: PriceLevel[] }) {
    this._data = data;

    this._data.buy = sortBy(this._data.buy, (priceLevel) => -priceLevel.price);
    this._data.sell = sortBy(this._data.sell, (priceLevel) => priceLevel.price);

    this.cumulativeBuy = zip<number>(
      this._data.buy.map((priceLevel) => priceLevel.price),
      cumsum(this._data.buy.map((priceLevel) => priceLevel.volume)),
    ) as [number, number][];

    this.cumulativeSell = zip<number>(
      this._data.sell.map((priceLevel) => priceLevel.price),
      cumsum(this._data.sell.map((priceLevel) => priceLevel.volume)),
    ) as [number, number][];

    this.prices = sortBy([
      ...this._data.buy.map((priceLevel) => priceLevel.price),
      ...this._data.sell.map((priceLevel) => priceLevel.price),
    ]);

    this.priceLabels = this.prices.map((price) => this.priceFormat(price));

    this.volumes = orderBy(
      [...this.cumulativeBuy, ...this.cumulativeSell],
      ["0"],
    ).map((priceLevel) => priceLevel[1]);

    this.volumeLabels = this.volumes.map((volume) => this.volumeFormat(volume));
    this.invalidate();
  }

  set indicativePrice(price: number) {
    this._indicativePrice = price;

    this.axis.indicativePrice = price;
    this.invalidate();
  }

  set midPrice(price: number) {
    this._midPrice = price;
    this.invalidate();
  }

  get height(): number {
    return this.chart.renderer.view.height;
  }

  get width(): number {
    return this.chart.renderer.view.width;
  }

  get span() {
    return this._span;
  }

  set span(span: number) {
    this._span = span;
    this.invalidate();
  }
}
