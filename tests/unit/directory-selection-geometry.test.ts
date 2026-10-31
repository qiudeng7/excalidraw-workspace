// 框选几何是纯函数：只验证内容坐标换算、矩形归一化、命中判定与边缘自动滚动步长。
// 不涉及 DOM 事件、rAF、真实滚动容器或选择状态（前者由 sidebar-multiselect 浏览器用例覆盖，
// 后者由 directory-selection.test.ts 覆盖）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  directoryAutoScrollDelta,
  directorySelectionRect,
  hitDirectorySelectionRows,
  toDirectoryContentPoint,
} from "../../src/lib/directory-selection-geometry";

test("客户端坐标换算为内容坐标：减去视口起点并加上滚动偏移", () => {
  const point = toDirectoryContentPoint(
    { x: 140, y: 220 },
    { left: 20, top: 60, scrollLeft: 0, scrollTop: 90 },
  );

  assert.deepEqual(point, { x: 120, y: 250 });
  assert.deepEqual(
    toDirectoryContentPoint(
      { x: 0, y: 0 },
      { left: 0, top: 0, scrollLeft: 15, scrollTop: 0 },
    ),
    { x: 15, y: 0 },
    "横向偏移只为对齐内容，不引入额外增量",
  );
});

test("反向拖出的矩形归一化为同一左上右下区间", () => {
  const forward = directorySelectionRect({ x: 10, y: 20 }, { x: 90, y: 80 });
  const backward = directorySelectionRect({ x: 90, y: 80 }, { x: 10, y: 20 });

  assert.deepEqual(forward, { left: 10, top: 20, right: 90, bottom: 80 });
  assert.deepEqual(backward, forward);
});

test("只有正面积相交才命中：贴边、零面积与不相交都不算", () => {
  const rows = [
    { key: "canvas:a", rect: { left: 0, top: 0, right: 100, bottom: 30 } },
    { key: "folder:f", rect: { left: 0, top: 34, right: 100, bottom: 64 } },
    { key: "canvas:b", rect: { left: 0, top: 68, right: 100, bottom: 98 } },
  ];
  const hit = (top: number, bottom: number) =>
    hitDirectorySelectionRows({ left: 10, top, right: 90, bottom }, rows);

  assert.deepEqual(hit(0, 98), ["canvas:a", "folder:f", "canvas:b"]);
  assert.deepEqual(hit(0, 30), ["canvas:a"], "只与第一行面积相交");
  assert.deepEqual(hit(30, 34), [], "贴边不算命中");

  const zero = hitDirectorySelectionRows(
    { left: 40, top: 10, right: 40, bottom: 20 },
    rows,
  );

  assert.deepEqual(zero, [], "零面积矩形不命中任何行");
});

test("命中结果按行顺序去重，与矩形拖出方向无关", () => {
  const rows = [
    { key: "canvas:a", rect: { left: 0, top: 0, right: 100, bottom: 30 } },
    { key: "canvas:a", rect: { left: 0, top: 0, right: 100, bottom: 30 } },
    { key: "canvas:b", rect: { left: 0, top: 34, right: 100, bottom: 64 } },
  ];
  const rect = directorySelectionRect({ x: 90, y: 60 }, { x: 10, y: 5 });

  assert.deepEqual(hitDirectorySelectionRows(rect, rows), [
    "canvas:a",
    "canvas:b",
  ]);
});

test("边缘自动滚动沿用旧阈值，视口过矮时上边缘优先", () => {
  assert.equal(directoryAutoScrollDelta(50, 100, 600), -9, "上边缘向上滚");
  assert.equal(directoryAutoScrollDelta(580, 100, 600), 9, "下边缘向下滚");
  assert.equal(directoryAutoScrollDelta(300, 100, 600), 0, "中间不滚");
  assert.equal(
    directoryAutoScrollDelta(104, 100, 600),
    -9,
    "刚进入上边缘带就滚",
  );
  assert.equal(
    directoryAutoScrollDelta(558, 100, 600),
    0,
    "上边缘带之外、下边缘带之前保持静止",
  );
  assert.equal(
    directoryAutoScrollDelta(120, 100, 140),
    -9,
    "视口高度不足两条阈值带时上边缘优先",
  );
});
