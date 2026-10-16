#!/usr/bin/env node
// pnpm build:editor && PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node packages/excalidraw/tests/arrowSelection.browser.mjs
// Real Chromium editor pixels + geometry/cache regressions, no account or external requests.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve, extname, basename } from "node:path";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import http from "node:http";

const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(packagePath, "package.json"));
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const esbuild = require("esbuild");
const directory = await mkdtemp(
  resolve(tmpdir(), "excalidraw-arrow-selection-"),
);
const screenshots = resolve(packagePath, "../../test-results/arrow-selection");
let browser, server;
try {
  const fixture = `
import React from ${JSON.stringify(require.resolve("react"))};
import { createRoot } from ${JSON.stringify(require.resolve("react-dom/client"))};
import { Excalidraw, convertToExcalidrawElements, exportToSvg, exportToBlob, serializeAsJSON } from ${JSON.stringify(packagePath + "/dist/dev/index.js")};
import ${JSON.stringify(packagePath + "/dist/dev/index.css")};
import { getArrowSelectionShape, ShapeCache } from ${JSON.stringify(packagePath + "/lib/element/src/shape.ts")};
import { renderArrowSelection } from ${JSON.stringify(packagePath + "/renderer/arrowSelection.ts")};
import { elementWithCanvasCache, renderElement } from ${JSON.stringify(packagePath + "/lib/element/src/renderElement.ts")};
import { getTransformHandles } from ${JSON.stringify(packagePath + "/lib/element/src/transformHandles.ts")};
import { LinearElementEditor } from ${JSON.stringify(packagePath + "/lib/element/src/linearElementEditor.ts")};
import rough from ${JSON.stringify(require.resolve("roughjs/bin/rough"))};
window.core={getArrowSelectionShape,ShapeCache,renderArrowSelection,elementWithCanvasCache,renderElement,getTransformHandles,LinearElementEditor,rough};
window.makeElements=specs=>convertToExcalidrawElements(specs,{regenerateIds:false});
window.exports={exportToSvg,exportToBlob,serializeAsJSON};
function Harness(){
 const [flags,setFlags]=React.useState({arrowSelectionHighlight:true,shortArrowheads:true});
 window.setFlags=setFlags;
 return <Excalidraw {...flags} autoFocus initialData={{elements:[],appState:{scrollX:0,scrollY:0,zoom:{value:1}}}} onInitialize={api=>window.api=api}/>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
window.alpha=(x,y,r=2)=>{const c=document.querySelector('canvas.interactive'),s=c.width/c.getBoundingClientRect().width,ctx=c.getContext('2d');return Math.max(...Array.from(ctx.getImageData(Math.round((x-r)*s),Math.round((y-r)*s),Math.max(1,Math.round((r*2+1)*s)),Math.max(1,Math.round((r*2+1)*s))).data).filter((_,i)=>i%4===3));};
window.select=(specs,ids)=>{
 const elements=window.makeElements(specs);
 const a=elements.find(e=>e.type==='arrow');
 window.api.updateScene({elements,appState:{selectedElementIds:Object.fromEntries(ids.map(id=>[id,true])),selectedGroupIds:{},selectedLinearElement:ids.length===1&&a&&ids[0]===a.id?new LinearElementEditor(a,new Map(elements.map(e=>[e.id,e]))):null,scrollX:0,scrollY:0,zoom:{value:1}}});
};
`;
  await esbuild.build({
    stdin: {
      contents: fixture,
      sourcefile: "entry.jsx",
      resolveDir: packagePath,
      loader: "jsx",
    },
    bundle: true,
    outfile: resolve(directory, "entry.js"),
    platform: "browser",
    format: "esm",
    loader: {
      ".woff2": "file",
      ".ttf": "file",
      ".png": "file",
      ".svg": "file",
    },
    define: {
      "process.env.NODE_ENV": '"development"',
      "import.meta.env": "{}",
    },
    logLevel: "silent",
  });
  await writeFile(
    resolve(directory, "index.html"),
    '<html><head><link rel="stylesheet" href="/entry.css"></head><body style="margin:0"><div id="root" style="height:100vh"></div><script type="module" src="/entry.js"></script></body></html>',
  );
  server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, "http://localhost").pathname;
      const file = resolve(
        directory,
        pathname === "/" ? "index.html" : "." + pathname,
      );
      if (!file.startsWith(directory + "/"))
        throw new Error("Invalid fixture path");
      const data = await readFile(file);
      res.writeHead(200, {
        "Content-Type":
          {
            ".js": "text/javascript",
            ".css": "text/css",
            ".html": "text/html",
          }[extname(file)] || "application/octet-stream",
      });
      res.end(data);
    } catch (error) {
      console.warn("Browser fixture asset unavailable", error);
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {}),
    args: ["--no-sandbox"],
  });
  await mkdir(screenshots, { recursive: true });
  const page = await browser.newPage({
    viewport: { width: 1100, height: 750 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://**", (route) => route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => !!window.api);
  const settle = () =>
    page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
  const flags = async (on, short = true) => {
    await page.evaluate(
      ([on, short]) =>
        window.setFlags({
          arrowSelectionHighlight: on,
          shortArrowheads: short,
        }),
      [on, short],
    );
    await page.waitForFunction(
      (on) => window.api.getAppState().arrowSelectionHighlight === on,
      !!on,
    );
    await settle();
  };
  const diagonal = {
    id: "arrow",
    type: "arrow",
    x: 200,
    y: 200,
    points: [
      [0, 0],
      [260, 160],
    ],
    roughness: 0,
  };
  const rect = {
    id: "box",
    type: "rectangle",
    x: 650,
    y: 150,
    width: 120,
    height: 130,
    roughness: 0,
  };
  await page.evaluate(
    ([a, b]) => window.select([a, b], ["arrow", "box"]),
    [diagonal, rect],
  );
  await settle();
  assert.ok(
    (await page.evaluate(() => window.alpha(330, 280))) > 0,
    "multi arrow shaft must be highlighted",
  );
  assert.equal(
    await page.evaluate(() => window.alpha(330, 196)),
    0,
    "no individual arrow bbox",
  );
  assert.ok(
    (await page.evaluate(() => window.alpha(710, 146))) > 0,
    "other element bbox remains",
  );
  assert.ok(
    (await page.evaluate(() => window.alpha(500, 146))) > 0,
    "multi common bounds remain",
  );
  await page.screenshot({ path: resolve(screenshots, "multi-on.png") });
  const before = await page.evaluate(() =>
    JSON.stringify(window.api.getSceneElements()),
  );
  const renderExports = () =>
    page.evaluate(async () => {
      const api = window.api,
        options = {
          elements: api.getSceneElements(),
          appState: api.getAppState(),
          files: {},
        };
      const svg = await window.exports.exportToSvg({
        ...options,
        skipInliningFonts: true,
      });
      const png = await window.exports.exportToBlob(options);
      return {
        svg: svg.outerHTML,
        png: [...new Uint8Array(await png.arrayBuffer())],
        json: window.exports.serializeAsJSON(
          options.elements,
          options.appState,
          {},
          "local",
        ),
      };
    });
  const exportsOn = await renderExports();
  await flags(false);
  assert.equal(await page.evaluate(() => window.alpha(330, 280)), 0);
  assert.ok(
    (await page.evaluate(() => window.alpha(330, 196))) > 0,
    "off restores arrow bbox",
  );
  await page.screenshot({ path: resolve(screenshots, "multi-off.png") });
  assert.deepEqual(
    await renderExports(),
    exportsOn,
    "toggle leaves SVG/PNG/JSON unchanged",
  );
  assert.equal(
    await page.evaluate(() => JSON.stringify(window.api.getSceneElements())),
    before,
  );
  assert.equal(
    JSON.parse(exportsOn.json).appState.arrowSelectionHighlight,
    undefined,
  );
  console.log(
    "✓ actual multi-selection pixels: shaft/head indicator, old bbox toggle, other bbox/common bounds; exports/data unchanged",
  );

  await flags(true);
  await page.evaluate(
    ([a, b]) => window.select([a, b], ["arrow"]),
    [diagonal, rect],
  );
  await settle();
  await page.mouse.move(460, 360);
  await page.mouse.down();
  await page.mouse.move(500, 400, { steps: 5 });
  await page.mouse.up();
  assert.notDeepEqual(
    await page.evaluate(() => window.api.getSceneElements()[0].points),
    diagonal.points,
    "endpoint editing remains functional with path highlight",
  );
  console.log(
    "✓ real endpoint drag still edits arrow with path highlight enabled",
  );

  const curve = {
    id: "curve",
    type: "arrow",
    x: 220,
    y: 250,
    points: [
      [0, 0],
      [100, -90],
      [220, 50],
      [360, -30],
    ],
    roundness: { type: 2 },
    roughness: 0,
  };
  await flags(true);
  await page.evaluate(
    ([a, b]) => window.select([a, b], ["curve"]),
    [curve, rect],
  );
  await settle();
  await page.screenshot({ path: resolve(screenshots, "curve-single-on.png") });
  const handle = await page.evaluate(() => {
    const api = window.api,
      arrow = api.getSceneElements()[0];
    const h = window.core.getTransformHandles(
      arrow,
      api.getAppState().zoom,
      new Map([[arrow.id, arrow]]),
      "mouse",
      {},
    ).rotation;
    return [h[0] + h[2] / 2, h[1] + h[3] / 2];
  });
  await page.mouse.move(...handle);
  await page.mouse.down();
  await page.mouse.move(handle[0] + 5, handle[1] + 5);
  await settle();
  assert.equal(
    await page.evaluate(() => window.api.getAppState().isRotating),
    false,
    "no invisible rotation hit region when on",
  );
  await page.mouse.up();
  await page.evaluate(
    ([a, b]) => window.select([a, b], ["curve"]),
    [curve, rect],
  );
  await flags(false);
  await page.screenshot({ path: resolve(screenshots, "curve-single-off.png") });
  await page.mouse.move(...handle);
  await page.mouse.down();
  await page.mouse.move(handle[0] + 5, handle[1] + 5);
  await settle();
  assert.equal(
    await page.evaluate(() => window.api.getAppState().isRotating),
    true,
    "old rotation hit region restored when off",
  );
  await page.mouse.up();
  console.log(
    "✓ single multipoint arrow has no floating bbox handles/ghost rotation hit when on; off restores original handles",
  );

  const result = await page.evaluate(() => {
    const c = window.core,
      api = window.api;
    const alpha = (canvas, x, y, r = 2) => {
      const data = canvas
        .getContext("2d")
        .getImageData(
          Math.round(x - r),
          Math.round(y - r),
          r * 2 + 1,
          r * 2 + 1,
        ).data;
      return Math.max(...Array.from(data).filter((_, i) => i % 4 === 3));
    };
    const spec = {
      id: "shaft",
      type: "arrow",
      x: 120,
      y: 150,
      points: [
        [0, 0],
        [320, 160],
      ],
      roughness: 0,
      label: { text: "箭头标签", fontSize: 24 },
    };
    const elements = window.makeElements([spec]);
    const arrow = elements.find((e) => e.type === "arrow");
    const label = elements.find((e) => e.type === "text");
    const map = new Map(elements.map((e) => [e.id, e]));
    const state = {
      ...api.getAppState(),
      scrollX: 0,
      scrollY: 0,
      zoom: { value: 1 },
      shortArrowheads: true,
      theme: "light",
      viewBackgroundColor: "#fff",
      selectedElementIds: {},
      hoveredElementIds: {},
    };
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 650;
    const config = {
      shortArrowheads: true,
      theme: "light",
      canvasBackgroundColor: "#fff",
      isExporting: false,
      embedsValidationStatus: null,
      imageCache: new Map(),
      renderGrid: false,
      elementsPendingErasure: new Set(),
      pendingFlowchartNodes: null,
    };
    c.renderElement(
      arrow,
      map,
      map,
      c.rough.canvas(canvas),
      canvas.getContext("2d"),
      config,
      state,
    );
    const shape = c.ShapeCache.get(arrow, "light", true),
      bitmap = c.elementWithCanvasCache.get(arrow);
    if (!shape || !bitmap)
      throw Error("static drawable and real bitmap must be generated");
    const indicatorCanvas = document.createElement("canvas");
    indicatorCanvas.width = 900;
    indicatorCanvas.height = 650;
    c.renderArrowSelection(
      indicatorCanvas.getContext("2d"),
      arrow,
      map,
      state,
      "#f00",
    );
    const cachePreserved =
      c.ShapeCache.get(arrow, "light", true) === shape &&
      c.elementWithCanvasCache.get(arrow) === bitmap;
    const pos = c.LinearElementEditor.getBoundTextElementPosition(
      arrow,
      label,
      map,
    );
    const labelCenterAlpha = alpha(
      indicatorCanvas,
      pos.x + label.width / 2,
      pos.y + label.height / 2,
      1,
    );
    const short = c.getArrowSelectionShape(arrow, state);
    const shortAgain = c.getArrowSelectionShape(arrow, state);
    const long = c.getArrowSelectionShape(arrow, {
      ...state,
      shortArrowheads: false,
    });
    const nonceShape = c.getArrowSelectionShape(arrow, state);
    arrow.versionNonce++;
    const nonceRefresh = c.getArrowSelectionShape(arrow, state) !== nonceShape;
    const oldShape = c.getArrowSelectionShape(arrow, state);
    arrow.version++;
    arrow.points = [
      [0, 0],
      [300, 140],
    ];
    const versionRefresh = c.getArrowSelectionShape(arrow, state) !== oldShape;
    const path = (s) =>
      s.flatMap((d) =>
        d.sets.filter((x) => x.type === "path").map((x) => x.ops),
      );
    const curve = window.makeElements([
      {
        type: "arrow",
        x: 150,
        y: 230,
        points: [
          [0, 0],
          [120, -90],
          [260, 40],
          [360, -20],
        ],
        roundness: { type: 2 },
        roughness: 0,
      },
    ])[0];
    const elbow = window.makeElements([
      {
        type: "arrow",
        x: 150,
        y: 150,
        points: [
          [0, 0],
          [150, 0],
          [150, 150],
          [300, 150],
        ],
        elbowed: true,
        roughness: 0,
      },
    ])[0];
    const curveOps = path(c.getArrowSelectionShape(curve, state))[0];
    const elbowOps = path(c.getArrowSelectionShape(elbow, state))[0];
    const curved = curveOps.find((op) => op.op === "bcurveTo");
    const curvedIndex = curveOps.indexOf(curved),
      start = curveOps[curvedIndex - 1].data;
    const sx = start[start.length - 2],
      sy = start[start.length - 1],
      d = curved.data;
    const midpoint = [
      curve.x + (sx + 3 * d[0] + 3 * d[2] + d[4]) / 8,
      curve.y + (sy + 3 * d[1] + 3 * d[3] + d[5]) / 8,
    ];
    const cc = document.createElement("canvas");
    cc.width = 900;
    cc.height = 650;
    c.renderArrowSelection(
      cc.getContext("2d"),
      curve,
      new Map([[curve.id, curve]]),
      state,
      "#f00",
    );
    const curvePixel = alpha(cc, ...midpoint);
    const ec = document.createElement("canvas");
    ec.width = 900;
    ec.height = 650;
    c.renderArrowSelection(
      ec.getContext("2d"),
      elbow,
      new Map([[elbow.id, elbow]]),
      state,
      "#f00",
    );
    const elbowCornerAlpha = alpha(ec, 300, 150, 1);
    const elbowRoundAlpha = alpha(ec, 295, 155, 2);
    const headInteriors = [];
    for (const endArrowhead of [
      "circle",
      "circle_outline",
      "triangle",
      "triangle_outline",
      "diamond",
      "diamond_outline",
    ]) {
      const a = window.makeElements([
        {
          type: "arrow",
          x: 120,
          y: 150,
          points: [
            [0, 0],
            [300, 0],
          ],
          endArrowhead,
          roughness: 0,
        },
      ])[0];
      const hs = c.getArrowSelectionShape(a, state).slice(1);
      const fill = hs.flatMap((s) => s.sets).find((s) => s.type === "fillPath");
      const values = fill.ops.flatMap((op) => op.data);
      const xs = values.filter((_, i) => i % 2 === 0),
        ys = values.filter((_, i) => i % 2 === 1);
      const x = a.x + (Math.min(...xs) + Math.max(...xs)) / 2,
        y = a.y + (Math.min(...ys) + Math.max(...ys)) / 2;
      const cv = document.createElement("canvas");
      cv.width = 900;
      cv.height = 650;
      c.renderArrowSelection(
        cv.getContext("2d"),
        a,
        new Map([[a.id, a]]),
        state,
        "#f00",
      );
      headInteriors.push(alpha(cv, x, y, 0));
    }
    const overlap = window.makeElements([
      {
        type: "arrow",
        x: 120,
        y: 150,
        points: [
          [0, 0],
          [200, 0],
          [200, 200],
          [0, 200],
          [0, 5],
        ],
        startArrowhead: "circle",
        endArrowhead: "circle",
        roughness: 0,
        strokeWidth: 2,
      },
    ])[0];
    const oc = document.createElement("canvas");
    oc.width = 900;
    oc.height = 650;
    c.renderArrowSelection(
      oc.getContext("2d"),
      overlap,
      new Map([[overlap.id, overlap]]),
      state,
      "#f00",
    );
    const overlapAlpha = alpha(oc, 120, 155, 0);
    const big = window.makeElements([
      {
        type: "arrow",
        x: 1000,
        y: 1000,
        points: [
          [0, 0],
          [10000, 0],
          [10000, 10000],
          [0, 10000],
        ],
        roundness: { type: 2 },
        endArrowhead: "triangle",
        roughness: 0,
      },
    ])[0];
    const bigOps = path(c.getArrowSelectionShape(big, state))[0];
    let previous = [0, 0],
      rightmost = [0, 0];
    for (const op of bigOps) {
      if (op.op === "move") previous = op.data;
      if (op.op === "bcurveTo") {
        const d = op.data;
        const mid = [
          (previous[0] + 3 * d[0] + 3 * d[2] + d[4]) / 8,
          (previous[1] + 3 * d[1] + 3 * d[3] + d[5]) / 8,
        ];
        if (mid[0] > rightmost[0]) rightmost = mid;
        previous = d.slice(-2);
      }
    }
    const bc = document.createElement("canvas");
    bc.width = 900;
    bc.height = 650;
    bc.getContext("2d").scale(0.04, 0.04);
    c.renderArrowSelection(
      bc.getContext("2d"),
      big,
      new Map([[big.id, big]]),
      { ...state, zoom: { value: 0.04 } },
      "#f00",
    );
    const overshootAlpha = alpha(
      bc,
      (big.x + rightmost[0]) * 0.04,
      (big.y + rightmost[1]) * 0.04,
      2,
    );
    const rotatedElements = window.makeElements([
      { ...spec, angle: Math.PI / 3 },
    ]);
    const rotatedArrow = rotatedElements.find((e) => e.type === "arrow"),
      rotatedText = rotatedElements.find((e) => e.type === "text");
    const rotatedMap = new Map(rotatedElements.map((e) => [e.id, e]));
    const rp = c.LinearElementEditor.getBoundTextElementPosition(
      rotatedArrow,
      rotatedText,
      rotatedMap,
    );
    const lc = [rp.x + rotatedText.width / 2, rp.y + rotatedText.height / 2];
    const lcCanvas = document.createElement("canvas");
    lcCanvas.width = 900;
    lcCanvas.height = 650;
    c.renderArrowSelection(
      lcCanvas.getContext("2d"),
      rotatedArrow,
      rotatedMap,
      state,
      "#f00",
    );
    const theta = Math.atan2(160, 320) + Math.PI / 3,
      distance = rotatedText.height / 2 + 20;
    const rotatedLabel = [
      alpha(lcCanvas, ...lc, 1),
      alpha(
        lcCanvas,
        lc[0] + Math.cos(theta) * distance,
        lc[1] + Math.sin(theta) * distance,
        2,
      ),
    ];
    const rotations = [];
    for (const zoom of [0.5, 1, 2])
      for (const sampling of [1, 2]) {
        const a = window.makeElements([
          {
            type: "arrow",
            x: 180,
            y: 180,
            points: [
              [0, 0],
              [240, 0],
            ],
            angle: Math.PI / 3,
            roughness: 0,
          },
        ])[0];
        const cv = document.createElement("canvas");
        cv.width = 1600;
        cv.height = 1600;
        const ctx = cv.getContext("2d");
        ctx.scale(zoom * sampling, zoom * sampling);
        c.renderArrowSelection(
          ctx,
          a,
          new Map([[a.id, a]]),
          { ...state, zoom: { value: zoom }, scrollX: 20, scrollY: 10 },
          "#f00",
        );
        rotations.push(
          alpha(
            cv,
            (300 + 60 * Math.cos(Math.PI / 3) + 20) * zoom * sampling,
            (180 + 60 * Math.sin(Math.PI / 3) + 10) * zoom * sampling,
            2,
          ),
        );
      }
    return {
      cachePreserved,
      labelCenterAlpha,
      reuse: short === shortAgain,
      headsDiffer: JSON.stringify(path(short)) !== JSON.stringify(path(long)),
      nonceRefresh,
      versionRefresh,
      curveB: curveOps.some((o) => o.op === "bcurveTo"),
      elbowB: elbowOps.some((o) => o.op === "bcurveTo"),
      curvePixel,
      elbowCornerAlpha,
      elbowRoundAlpha,
      rotations,
      rotatedLabel,
      headInteriors,
      overlapAlpha,
      overshootAlpha,
    };
  });
  assert.equal(result.cachePreserved, true);
  assert.equal(result.labelCenterAlpha, 0);
  for (const key of [
    "reuse",
    "headsDiffer",
    "nonceRefresh",
    "versionRefresh",
    "curveB",
    "elbowB",
  ])
    assert.equal(result[key], true, key);
  assert.ok(result.curvePixel > 0);
  assert.equal(result.elbowCornerAlpha, 0);
  assert.ok(result.elbowRoundAlpha > 0);
  assert.ok(result.rotations.every((a) => a > 0));
  assert.equal(result.overlapAlpha, 0);
  assert.ok(
    result.overshootAlpha > 0,
    "filled head mask retains large Bézier overshoot",
  );
  assert.equal(result.rotatedLabel[0], 0);
  assert.ok(
    result.rotatedLabel[1] > 0,
    "rotated arrow resumes outside the scene-aligned label hole",
  );
  assert.ok(
    result.headInteriors.every((a) => a === 0),
    JSON.stringify(result.headInteriors),
  );
  console.log(
    "✓ real Canvas geometry: Bézier, rounded elbow, label hole, short heads, rotation/scroll/zoom/sampling; version/nonce cache; static shape/bitmap identities preserved",
  );

  // Group/locked/remote policies and instance lifecycle use the actual editor.
  await flags(true);
  const group = [
    { ...diagonal, groupIds: ["group"] },
    { ...rect, groupIds: ["group"] },
  ];
  await page.evaluate((specs) => {
    window.select(specs, ["arrow", "box"]);
    window.api.updateScene({ appState: { selectedGroupIds: { group: true } } });
  }, group);
  await settle();
  assert.equal(
    await page.evaluate(() => window.alpha(330, 280)),
    0,
    "group does not expand individual indicators",
  );
  await page.evaluate(
    (a) =>
      window.select(
        [
          { ...a, locked: true },
          {
            id: "box",
            type: "rectangle",
            x: 650,
            y: 150,
            width: 120,
            height: 130,
          },
        ],
        ["arrow", "box"],
      ),
    diagonal,
  );
  await settle();
  assert.equal(
    await page.evaluate(() => window.alpha(330, 280)),
    0,
    "locked arrow retains old border, not new indicator",
  );
  await page.evaluate(
    ([a, b]) => {
      window.select([a, b], ["arrow", "box"]);
      window.api.updateScene({
        collaborators: new Map([
          ["peer", { selectedElementIds: { arrow: true }, username: "Peer" }],
        ]),
      });
    },
    [diagonal, rect],
  );
  await settle();
  assert.ok(
    (await page.evaluate(() => window.alpha(330, 196))) > 0,
    "remote border remains alongside local indicator",
  );
  await page.evaluate(() => window.api.resetScene());
  assert.equal(
    await page.evaluate(() => window.api.getAppState().arrowSelectionHighlight),
    true,
  );
  await page.evaluate(() =>
    window.api.updateScene({ appState: { arrowSelectionHighlight: false } }),
  );
  assert.equal(
    await page.evaluate(() => window.api.getAppState().arrowSelectionHighlight),
    true,
    "scene updates cannot inject instance setting",
  );
  await flags(undefined);
  assert.equal(
    await page.evaluate(() => window.api.getAppState().arrowSelectionHighlight),
    false,
    "standalone default remains old behavior",
  );
  assert.deepEqual(errors, []);
  console.log(
    `✓ group/locked/remote policies, reset/import isolation, standalone opt-in; screenshots: ${screenshots}`,
  );
} finally {
  await browser?.close();
  if (server) await new Promise((done) => server.close(done));
  // Only the unique fixture directory allocated above is disposable; keep screenshots.
  if (
    dirname(directory) !== tmpdir() ||
    !basename(directory).startsWith("excalidraw-arrow-selection-")
  )
    throw new Error("Unsafe cleanup path");
  await rm(directory, { recursive: true, force: true });
}
