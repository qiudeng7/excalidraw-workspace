// 侧栏批选控制器是纯状态：本文件只验证选择语义（单击/切换/区间/框选/裁剪/快照恢复）。
// 不挂载 Vue 组件、不绑定 DOM 事件、不发请求；几何命中与自动滚动见 directory-selection-geometry.test.ts，
// 手势与界面联动由 tests/browser/sidebar-multiselect.spec.ts 覆盖。
import { test } from "node:test";
import assert from "node:assert/strict";
import { ref } from "vue";
import {
  useDirectorySelection,
  type DirectorySelectionController,
  type DirectorySelectionSnapshot,
} from "../../src/composables/use-directory-selection";

const setup = (visible: string[]) => {
  const keys = ref<string[]>(visible);
  const selection = useDirectorySelection(() => keys.value);

  return { keys, selection };
};

const keys = (selection: DirectorySelectionController) => [
  ...selection.state.value.selectedKeys,
];
const anchor = (selection: DirectorySelectionController) =>
  selection.state.value.anchor;
const mode = (selection: DirectorySelectionController) =>
  selection.state.value.explicitMode;

test("普通单击清空集合、把锚点设为该行；未知行点击不改变状态", () => {
  const { selection } = setup(["canvas:c1", "canvas:c2", "folder:f1"]);

  selection.click("canvas:c1", "toggle");
  selection.click("canvas:c2", "toggle");
  assert.deepEqual(keys(selection), ["canvas:c1", "canvas:c2"]);

  selection.click("canvas:c2", "plain");
  assert.deepEqual(keys(selection), []);
  assert.equal(anchor(selection), "canvas:c2");

  selection.click("canvas:missing", "plain");
  assert.deepEqual(keys(selection), [], "未知行的普通单击不能凭空选中");
  assert.equal(anchor(selection), "canvas:c2", "未知行点击不应挪动锚点");
});

test("Ctrl 单击切换同一行并把锚点移到该行", () => {
  const { selection } = setup(["canvas:c1", "canvas:c2", "canvas:c3"]);

  selection.click("canvas:c1", "toggle");
  assert.deepEqual(keys(selection), ["canvas:c1"]);
  assert.equal(anchor(selection), "canvas:c1");

  selection.click("canvas:c3", "toggle");
  assert.deepEqual(
    keys(selection),
    ["canvas:c1", "canvas:c3"],
    "集合按可见顺序排列",
  );
  assert.equal(anchor(selection), "canvas:c3");

  selection.click("canvas:c1", "toggle");
  assert.deepEqual(keys(selection), ["canvas:c3"]);
  assert.equal(anchor(selection), "canvas:c1");
});

test("Shift 单击用锚点到该行的闭区间替换集合，并保留原锚点", () => {
  const { selection } = setup([
    "canvas:c1",
    "folder:f1",
    "canvas:c2",
    "canvas:c3",
  ]);

  selection.click("canvas:c1", "plain");
  selection.click("canvas:c2", "range");
  assert.deepEqual(keys(selection), ["canvas:c1", "folder:f1", "canvas:c2"]);
  assert.equal(anchor(selection), "canvas:c1", "Shift 单击不移动锚点");

  // 第二次 Shift 更近：集合收缩，仍然从 c1 起算。
  selection.click("folder:f1", "range");
  assert.deepEqual(keys(selection), ["canvas:c1", "folder:f1"]);
  assert.equal(anchor(selection), "canvas:c1");
});

test("Ctrl+Shift 在既有集合上追加区间，且不移动锚点", () => {
  const { selection } = setup(["canvas:c1", "canvas:c2", "folder:f1"]);

  selection.click("canvas:c2", "plain");
  selection.click("folder:f1", "toggle");
  selection.click("canvas:c1", "add-range");
  assert.deepEqual(
    keys(selection),
    ["canvas:c1", "canvas:c2", "folder:f1"],
    "追加区间与已有集合取并集",
  );
  assert.equal(anchor(selection), "folder:f1");
});

test("无有效锚点（或锚点已不可见）的 Shift 单击只选本行并建立锚点", () => {
  const { keys: visible, selection } = setup(["canvas:c1", "canvas:c2"]);

  selection.click("canvas:c2", "range");
  assert.deepEqual(keys(selection), ["canvas:c2"]);
  assert.equal(anchor(selection), "canvas:c2");

  visible.value = ["canvas:c1"];
  selection.reconcile();
  selection.click("canvas:c1", "range");
  assert.deepEqual(keys(selection), ["canvas:c1"]);
  assert.equal(anchor(selection), "canvas:c1");
});

test("框选每帧都用固定起始快照重算：替换/异或/并集，缩框后回退", () => {
  const { selection } = setup([
    "canvas:c1",
    "canvas:c2",
    "canvas:c3",
    "canvas:c4",
  ]);

  selection.click("canvas:c2", "toggle");
  const base = selection.snapshot();

  assert.deepEqual(base.selectedKeys, ["canvas:c2"], "起始快照只含已选行");

  selection.applyBox(["canvas:c1", "canvas:c2", "canvas:c3"], base, "replace");
  assert.deepEqual(keys(selection), ["canvas:c1", "canvas:c2", "canvas:c3"]);
  assert.equal(anchor(selection), "canvas:c1", "锚点取结果中显示顺序第一项");

  // 指针缩回只框到 c1：早先命中的行必须退出集合。
  selection.applyBox(["canvas:c1"], base, "replace");
  assert.deepEqual(keys(selection), ["canvas:c1"]);

  // 异或：起点 c2 已在集合内，框到 c2 时它反而退出。
  selection.applyBox(["canvas:c2", "canvas:c3"], base, "xor");
  assert.deepEqual(keys(selection), ["canvas:c3"]);

  selection.applyBox([], base, "xor");
  assert.deepEqual(
    keys(selection),
    ["canvas:c2"],
    "异或空命中等于回到起始快照",
  );

  selection.applyBox(["canvas:c3"], base, "add");
  assert.deepEqual(keys(selection), ["canvas:c2", "canvas:c3"]);
  assert.equal(anchor(selection), "canvas:c2");

  selection.applyBox([], base, "add");
  assert.deepEqual(keys(selection), ["canvas:c2"], "并集空命中等于起始快照");
  assert.equal(anchor(selection), "canvas:c2");
});

test("reconcile 按当前可见顺序裁剪且不自动退出显式模式；restore 按可见键裁剪", () => {
  const { keys: visible, selection } = setup(["canvas:c1", "canvas:c2"]);

  selection.enterExplicit("canvas:c1");
  selection.click("canvas:c2", "toggle");
  assert.deepEqual(keys(selection), ["canvas:c1", "canvas:c2"]);
  assert.equal(mode(selection), true);

  visible.value = [];
  selection.reconcile();
  assert.deepEqual(keys(selection), [], "真正消失的节点被裁掉");
  assert.equal(mode(selection), true, "裁剪不等于退出显式模式");

  const snapshot: DirectorySelectionSnapshot = {
    selectedKeys: ["canvas:c1", "canvas:c2"],
    anchor: "canvas:c1",
    explicitMode: false,
  };

  visible.value = ["canvas:c2"];
  selection.restore(snapshot);
  assert.deepEqual(keys(selection), ["canvas:c2"], "恢复时按当前可见键裁剪");
  assert.equal(
    anchor(selection),
    undefined,
    "锚点已不可见时一并失效，避免 Shift 从看不见的行起算",
  );
});

test("clear 清空集合并退出显式模式；snapshot 返回独立副本", () => {
  const { selection } = setup(["canvas:c1", "canvas:c2"]);

  selection.enterExplicit("canvas:c1");
  selection.click("canvas:c2", "toggle");
  const snapshot = selection.snapshot();

  (snapshot.selectedKeys as string[]).push("canvas:c3");
  assert.deepEqual(
    keys(selection),
    ["canvas:c1", "canvas:c2"],
    "快照是独立数组",
  );

  selection.clear();
  assert.deepEqual(keys(selection), []);
  assert.equal(anchor(selection), undefined);
  assert.equal(mode(selection), false);

  selection.restore(snapshot);
  assert.deepEqual(
    keys(selection),
    ["canvas:c1", "canvas:c2"],
    "恢复快照可回到旧集合",
  );
  assert.equal(mode(selection), true, "快照原样带回拍摄时的显式模式标记");
});
