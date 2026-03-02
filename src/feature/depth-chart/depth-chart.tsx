import "../../styles/variables.css";

import { NonIdealState } from "@ui/components";
import { useThrottledResizeObserver } from "@util/hooks";
import { defaultPriceFormat, numberFormatter } from "@util/misc";
import { ThemeVariant } from "@util/types";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

import { Chart } from "./chart";
import styles from "./depth-chart.module.css";
import { getColors, getDimensions, ColorConfig } from "./helpers";
import { string2hexObj } from "@ui/renderer";

function defaultVolumeFormat(volume: number) {
  return numberFormatter(0).format(volume);
}

/**
 * Standard font size in CSS pixels
 */
export const FONT_SIZE = 12;

/**
 * Height of the bottom price axis
 */
export const AXIS_HEIGHT = FONT_SIZE + 5;

export type PriceLevel = {
  price: number;
  volume: number;
};

export type DepthChartProps = {
  data: { buy: PriceLevel[]; sell: PriceLevel[] };

  /**
   *  Used to format values on price axis.
   */
  priceFormat?: (price: number) => string;

  /**
   * Used to format values volume axis,
   */
  volumeFormat?: (price: number) => string;

  /**
   * Indicative price if the auction ended now, 0 if not in auction mode.
   */
  indicativePrice?: number;

  /**
   *  Arithmetic average of the best bid price and best offer price.
   */
  midPrice?: number;
  /**
   * Override the default text to display when there is not enough data.
   */
  notEnoughDataText?: React.ReactNode;

  /**
   * Light or dark theme
   */
  theme?: ThemeVariant;

  /**
   * Common crypto trading pairs
   */
  pairCode?: string;

  /**
   * Override default colors
   */
  colorsConfig?: Partial<ColorConfig>;
  /**
   * Width of the stroke around the area curves in pixels
   */
  strokeWidth?: number;
  /**
   * Alpha of the fill area under the curves
   */
  fillAlpha?: number;
};

export interface DepthChartHandle {
  /**
   * Simulate the user hovering over the chart at a particular price
   */
  update(price: number): void;

  /**
   * Simulate the user's mouse leaving the chart
   */
  clear(): void;
}

export const DepthChart = forwardRef(
  (
    {
      data,
      priceFormat = defaultPriceFormat,
      volumeFormat = defaultVolumeFormat,
      indicativePrice = 0,
      midPrice = 0,
      notEnoughDataText = "No data",
      theme = "dark",
      pairCode,
      colorsConfig,
      strokeWidth,
      fillAlpha = 0.2,
    }: DepthChartProps,
    ref: React.Ref<DepthChartHandle>,
  ) => {
    const contentsRef = useRef<HTMLCanvasElement>(null!);
    const uiRef = useRef<HTMLCanvasElement>(null!);
    const chartRef = useRef<Chart>(null!);
    const styleRef = useRef<HTMLDivElement>(null!);

    const {
      ref: resizeOberverRef,
      width = 0,
      height = 0,
      devicePixelContentBoxSizeInlineSize,
      devicePixelContentBoxSizeBlockSize,
    } = useThrottledResizeObserver<HTMLDivElement>(50);

    /**
     * Create a new instance of the depth chart
     */
    useEffect(() => {
      const colors = colorsConfig
        ? string2hexObj(colorsConfig)
        : getColors(styleRef?.current);
      // console.log("colors", colors, colorsConfig);
      const dimensions = strokeWidth
        ? { strokeWidth }
        : getDimensions(styleRef?.current);
      chartRef.current = new Chart({
        chartView: contentsRef.current,
        axisView: uiRef.current,
        resolution: window.devicePixelRatio,
        width: 0,
        height: 0,
        priceFormat,
        volumeFormat,
        colors,
        dimensions,
        fillAlpha,
      });

      return () => {
        chartRef.current.destroy();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
      if (chartRef.current) {
        chartRef.current.priceFormat = priceFormat;
        chartRef.current.volumeFormat = volumeFormat;
      }
    }, [priceFormat, volumeFormat]);

    useEffect(() => {
      // chartRef.current.initialPriceDifference = 0;
      chartRef.current.span = 1;
      chartRef.current.axis.transform = 1;
    }, [pairCode]);

    // Resize chart only when dimensions change
    useEffect(() => {
      if (!chartRef.current) return;
      chartRef.current.resize(width, height);
    }, [height, width]);

    // Update chart data independently from resize
    useEffect(() => {
      if (!chartRef.current) return;
      chartRef.current.data = data;
    }, [data]);
    // useEffect(() => {
    //   chartRef.current.resize(
    //     devicePixelContentBoxSizeInlineSize
    //       ? devicePixelContentBoxSizeInlineSize / window.devicePixelRatio
    //       : width,
    //     devicePixelContentBoxSizeBlockSize
    //       ? devicePixelContentBoxSizeBlockSize / window.devicePixelRatio
    //       : height
    //   );

    //   chartRef.current.data = data;
    //   chartRef.current.render();
    // }, [
    //   height,
    //   width,
    //   data,
    //   devicePixelContentBoxSizeInlineSize,
    //   devicePixelContentBoxSizeBlockSize,
    // ]);

    useEffect(() => {
      chartRef.current.indicativePrice = indicativePrice;
    }, [indicativePrice]);

    useEffect(() => {
      chartRef.current.midPrice = midPrice;
    }, [midPrice]);

    useEffect(() => {
      requestAnimationFrame(() => {
        chartRef.current.colors = colorsConfig
          ? string2hexObj(colorsConfig)
          : getColors(styleRef?.current);
        chartRef.current.dimensions = strokeWidth
          ? { strokeWidth }
          : getDimensions(styleRef?.current);
      });
    }, [theme, colorsConfig, strokeWidth]);

    useImperativeHandle(ref, () => ({
      update(price: number) {
        chartRef.current.updatePrice(price);
      },
      clear() {
        chartRef.current.clearPrice();
      },
    }));

    // if (data.buy.length === 0 && data.sell.length === 0) {
    //   return (
    //     <div ref={styleRef} className={styles.container} data-theme={theme}>
    //       <NonIdealState title={notEnoughDataText} />
    //     </div>
    //   );
    // }

    return (
      <div ref={styleRef} className={styles.container} data-theme={theme}>
        <div ref={resizeOberverRef} className={styles.canvasContainer}>
          <canvas ref={contentsRef} className={styles.canvas} />
          <canvas ref={uiRef} className={styles.canvas} />
        </div>
      </div>
    );
  },
);

DepthChart.displayName = "DepthChart";
