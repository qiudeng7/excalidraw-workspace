/** 仅影响屏幕显示的实验选项，不属于场景或导出状态。 */
export interface CanvasRenderingOptions {
  smoothCache?: boolean;
  highQualitySmoothing?: boolean;
  directText?: boolean;
  directShapes?: boolean;
  alignPixels?: boolean;
  smoothCanvas?: boolean;
}
