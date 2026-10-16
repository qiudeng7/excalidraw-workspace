import {
  getArrowSelectionShape,
  getBoundTextElement,
  getElementAbsoluteCoords,
} from "@excalidraw/element";
import { BOUND_TEXT_PADDING } from "@excalidraw/common";
import type {
  ElementsMap,
  ExcalidrawArrowElement,
} from "@excalidraw/element/types";
import type { InteractiveCanvasAppState } from "../types";
import type { Drawable, Op } from "roughjs/bin/core";

const appendOps = (
  path: CanvasRenderingContext2D | Path2D,
  ops: readonly Op[],
) => {
  for (const { op, data } of ops) {
    switch (op) {
      case "move":
        path.moveTo(data[0], data[1]);
        break;
      case "lineTo":
        path.lineTo(data[0], data[1]);
        break;
      case "bcurveTo":
        path.bezierCurveTo(
          data[0],
          data[1],
          data[2],
          data[3],
          data[4],
          data[5],
        );
        break;
    }
  }
};

const strokeShapes = (
  context: CanvasRenderingContext2D,
  shapes: Drawable[],
) => {
  context.beginPath();
  for (const shape of shapes) {
    for (const set of shape.sets) {
      if (set.type === "path") appendOps(context, set.ops);
    }
  }

  context.stroke();
};

/** Draw only an indicator: no element mutation, hit geometry or export state. */
export const renderArrowSelection = (
  context: CanvasRenderingContext2D,
  arrow: ExcalidrawArrowElement,
  elementsMap: ElementsMap,
  appState: InteractiveCanvasAppState,
  selectionColor: string,
) => {
  if (
    arrow.points.length < 2 ||
    !arrow.points.every(
      (point) => Number.isFinite(point[0]) && Number.isFinite(point[1]),
    )
  )
    return;

  const shapes = getArrowSelectionShape(arrow, appState);

  if (!shapes.length) return;

  const [x1, y1, x2, y2] = getElementAbsoluteCoords(arrow, elementsMap);
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;

  context.save();
  context.translate(cx + appState.scrollX, cy + appState.scrollY);

  const label = getBoundTextElement(arrow, elementsMap);

  if (label) {
    // Labels stay axis-aligned in scene space even when the arrow rotates.
    // Match the static renderer's hole before applying the arrow's rotation.
    const [, , , , labelCx, labelCy] = getElementAbsoluteCoords(
      label,
      elementsMap,
    );
    const outerHalf = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)) + 400;

    context.beginPath();
    context.rect(-outerHalf, -outerHalf, outerHalf * 2, outerHalf * 2);
    context.rect(
      labelCx - cx - label.width / 2 - BOUND_TEXT_PADDING,
      labelCy - cy - label.height / 2 - BOUND_TEXT_PADDING,
      label.width + BOUND_TEXT_PADDING * 2,
      label.height + BOUND_TEXT_PADDING * 2,
    );
    context.clip("evenodd");
  }

  context.rotate(arrow.angle);
  context.translate(arrow.x - cx, arrow.y - cy);
  context.strokeStyle = selectionColor;
  context.lineWidth = 1.5 / appState.zoom.value;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.setLineDash([]);
  const heads = shapes.slice(1);
  const fills = heads.flatMap((shape) =>
    shape.sets.filter((set) => set.type === "fillPath"),
  );

  // The static painter fills circles/triangles/diamonds over the shaft. Cut
  // their interiors out of the indicator instead of painting a new background.
  context.save();
  for (const set of fills) {
    const mask = new Path2D();

    // Bounds include Bézier overshoot beyond the control-point envelope.
    mask.rect(
      x1 - arrow.x - 400,
      y1 - arrow.y - 400,
      x2 - x1 + 800,
      y2 - y1 + 800,
    );
    appendOps(mask, set.ops);
    // Intersect each complement separately: overlapping heads form a union,
    // not an even-odd XOR that would expose the shaft inside the overlap.
    context.clip(mask, "evenodd");
  }

  strokeShapes(context, [shapes[0]]);
  context.restore();
  strokeShapes(context, heads);
  context.restore();
};
