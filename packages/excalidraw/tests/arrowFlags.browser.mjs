#!/usr/bin/env node
/** 已构建编辑器的真实 Chromium 验收，不需要账户或后端。
 * pnpm build:editor
 * PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node packages/excalidraw/tests/arrowFlags.browser.mjs
 * 可选 CHROMIUM_PATH 指定系统 Chromium；未指定时使用 Playwright 的 Chromium。
 * 运行于临时目录和回环 HTTP，外部网络请求被阻止。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname } from 'node:path';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import http from 'node:http';
const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(packagePath, 'package.json'));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const esbuild = require('esbuild');
const reactPath = require.resolve('react');
const reactDomPath = require.resolve('react-dom/client');
const directory = await mkdtemp(resolve(tmpdir(), 'excalidraw-arrow-flags-'));
let browser, server;
try {
  const fixture = `import React from ${JSON.stringify(reactPath)};
import { createRoot } from ${JSON.stringify(reactDomPath)};
import { Excalidraw, convertToExcalidrawElements, exportToSvg, exportToBlob } from ${JSON.stringify(packagePath + '/dist/dev/index.js')};
import ${JSON.stringify(packagePath + '/dist/dev/index.css')};
window.makeElements=convertToExcalidrawElements;window.exportSvg=exportToSvg;window.exportBlob=exportToBlob;
function Harness(){const [flags,setFlags]=React.useState({arrowBindingOptimization:true,shortArrowheads:true});window.setFlags=setFlags;return <Excalidraw autoFocus={true} {...flags} onInitialize={api=>window.api=api} initialData={{elements:convertToExcalidrawElements([{id:'target',type:'rectangle',x:500,y:220,width:200,height:180,backgroundColor:'#fff',roughness:0}]),appState:{scrollX:0,scrollY:0,zoom:{value:1},currentItemRoughness:0}}} onChange={(elements,state)=>{window.lastElements=elements;window.lastState=state;}}/>;}
createRoot(document.getElementById('root')).render(<Harness/>);
import { LinearElementEditor } from ${JSON.stringify(packagePath + '/lib/element/src/linearElementEditor.ts')};
import { getBindingStrategyForDraggingBindingElementEndpoints, updateBoundPoint } from ${JSON.stringify(packagePath + '/lib/element/src/binding.ts')};
import { getArrowheadSize, getArrowheadAngle } from ${JSON.stringify(packagePath + '/lib/element/src/bounds.ts')};
import { hitElementItself } from ${JSON.stringify(packagePath + '/lib/element/src/collision.ts')};
import { serializeAsJSON } from ${JSON.stringify(packagePath + '/dist/dev/index.js')};
window.core={LinearElementEditor,getBindingStrategyForDraggingBindingElementEndpoints,updateBoundPoint,getArrowheadSize,getArrowheadAngle,hitElementItself,serializeAsJSON};
`;
  await esbuild.build({stdin:{contents:fixture,sourcefile:'entry.jsx',resolveDir:packagePath,loader:'jsx'},bundle:true,outfile:resolve(directory,'entry.js'),platform:'browser',format:'esm',loader:{'.woff2':'file','.ttf':'file','.png':'file','.svg':'file'},define:{'process.env.NODE_ENV':'"development"'},logLevel:'silent'});
  await writeFile(resolve(directory, 'index.html'), '<html><head><link rel="stylesheet" href="/entry.css"></head><body style="margin:0"><div id="root" style="height:100vh"></div><script type="module" src="/entry.js"></script></body></html>');
  server=http.createServer(async(req,res)=>{try{const pathname=new URL(req.url,'http://localhost').pathname;const file=resolve(directory,pathname==='/'?'index.html':'.'+pathname);if(!file.startsWith(directory+'/'))throw Error();const data=await readFile(file);const type={'.js':'text/javascript','.css':'text/css','.html':'text/html'}[extname(file)]||'application/octet-stream';res.writeHead(200,{'Content-Type':type});res.end(data);}catch{res.writeHead(404);res.end();}});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1100,height:750}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('https://**',r=>r.abort());
async function fresh(){await page.goto(origin,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>!!window.api);await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.api.getAppState().arrowBindingOptimization),true);assert.equal(await page.evaluate(()=>window.api.getAppState().shortArrowheads),true);await page.evaluate(()=>window.api.setActiveTool({type:'arrow'}));}
async function arrow(){return page.evaluate(()=>window.api.getSceneElements().filter(e=>e.type==='arrow').at(-1));}
const endpoint=a=>[a.x+a.points.at(-1)[0],a.y+a.points.at(-1)[1]];
async function drag(start,end){await page.mouse.move(...start);await page.mouse.down();await page.mouse.move(...end,{steps:8});await page.waitForTimeout(75);}
await fresh();await drag([300,310],[600,310]);assert.equal((await arrow()).endBinding.mode,'orbit');assert.ok(endpoint(await arrow())[0]<500);
await page.keyboard.down('Control');await page.waitForTimeout(75);assert.equal((await arrow()).endBinding.mode,'inside');assert.ok(endpoint(await arrow())[0]>550);
await page.keyboard.up('Control');await page.waitForTimeout(75);assert.equal((await arrow()).endBinding.mode,'orbit');assert.ok(endpoint(await arrow())[0]<500);
await page.keyboard.down('Control');await page.mouse.up();await page.waitForTimeout(75);const committed=await arrow();assert.equal(committed.endBinding.mode,'inside');await page.keyboard.up('Control');await page.waitForTimeout(75);assert.deepEqual(await arrow(),committed);assert.equal(await page.evaluate(()=>window.api.getAppState().arrowBindingInside),false);assert.equal(await page.evaluate(()=>window.api.getAppState().arrowBindingOptimizationActive),false);
console.log('✓ 初始props生效；内部命中orbit、静止Ctrl切换、松手inside提交和清临时状态');
await fresh();await page.keyboard.down('Control');await drag([600,310],[300,310]);assert.equal((await arrow()).startBinding.mode,'inside');await page.keyboard.up('Control');await page.waitForTimeout(75);assert.equal((await arrow()).startBinding.mode,'orbit');assert.ok((await arrow()).x<500);await page.mouse.up();assert.equal((await arrow()).startBinding.mode,'orbit');console.log('✓ Ctrl起点内部→终点空白→静止释放Ctrl恢复真实轮廓绑定');
await fresh();await page.evaluate(()=>window.setFlags({arrowBindingOptimization:false,shortArrowheads:true}));await page.waitForTimeout(75);await drag([300,310],[600,310]);assert.equal((await arrow()).endBinding.mode,'inside');await page.mouse.up();console.log('✓ 关闭连线优化恢复上游内部绑定');
await fresh();await drag([300,310],[600,310]);await page.mouse.up();await page.waitForTimeout(75);
const exports=await page.evaluate(async()=>{const api=window.api;const before=JSON.stringify(api.getSceneElements());const render=async()=>{const svg=await window.exportSvg({elements:api.getSceneElements(),appState:api.getAppState(),files:{},skipInliningFonts:true});const png=await window.exportBlob({elements:api.getSceneElements(),appState:api.getAppState(),files:{}});return{paths:[...svg.querySelectorAll('path')].map(p=>p.getAttribute('d')),png:[...new Uint8Array(await png.arrayBuffer())]};};const short=await render();window.setFlags({arrowBindingOptimization:true,shortArrowheads:false});await new Promise(r=>setTimeout(r,100));const long=await render();const json=JSON.parse(window.core.serializeAsJSON(api.getSceneElements(),api.getAppState(),{},'local'));return{before,after:JSON.stringify(api.getSceneElements()),short,long,jsonFlagKeys:Object.keys(json.appState).filter(k=>/arrowBinding|shortArrow/.test(k)),stateShort:api.getAppState().shortArrowheads};});assert.equal(exports.before,exports.after);assert.notDeepEqual(exports.short.paths,exports.long.paths);assert.notDeepEqual(exports.short.png,exports.long.png);assert.deepEqual(exports.jsonFlagKeys,[]);assert.equal(exports.stateShort,false);console.log('✓ 短头开关改SVG/PNG且不改任何元素/版本、不进JSON');
const geometry=await page.evaluate(()=>{const c=window.core,api=window.api;return['rectangle','ellipse','diamond'].flatMap(type=>[0,Math.PI/3].map(angle=>{const [target,arrow]=window.makeElements([{type,x:500,y:220,width:200,height:180,angle},{type:'arrow',x:300,y:310,points:[[0,0],[100,-60],[300,0]],roundness:{type:2}}]);arrow.endBinding={elementId:target.id,mode:'orbit',fixedPoint:[.5,.5]};const map=new Map([[target.id,target],[arrow.id,arrow]]);const state={...api.getAppState(),arrowBindingOptimization:true,arrowBindingOptimizationActive:true,arrowBindingInside:false,isBindingEnabled:true};const strategy=c.getBindingStrategyForDraggingBindingElementEndpoints(arrow,new Map([[2,{point:[300,0],isDragging:true}]]),600,310,map,[target,arrow],state);const point=c.updateBoundPoint(arrow,'endBinding',arrow.endBinding,target,map,true,true);return{type,angle,mode:strategy.end.mode,point,outside:!c.hitElementItself({element:target,point:[arrow.x+point[0],arrow.y+point[1]],elementsMap:map,threshold:0,overrideShouldTestInside:true})};}));});for(const result of geometry){assert.equal(result.mode,'orbit');assert.equal(result.outside,true);}console.log('✓ 3点曲线单端策略，矩形/椭圆/菱形与旋转目标轮廓几何');
await fresh();await page.evaluate(()=>{const elements=window.makeElements([{type:'rectangle',x:500,y:220,width:200,height:180,backgroundColor:'#fff',roughness:0},{type:'arrow',x:300,y:310,points:[[0,0],[100,-60],[300,0]],roundness:{type:2},roughness:0}]);const curved=elements[1];const linear=new window.core.LinearElementEditor(curved,new Map(elements.map(e=>[e.id,e])));linear.isEditing=true;linear.hoverPointIndex=2;linear.selectedPointsIndices=[2];window.api.updateScene({elements,appState:{selectedElementIds:{[curved.id]:true},selectedLinearElement:linear,activeTool:{type:'selection',customType:null,locked:false,lastActiveTool:null}}});});await page.waitForTimeout(150);await page.mouse.move(600,310);await page.mouse.down();await page.mouse.move(620,330,{steps:4});await page.waitForTimeout(75);const curveOrbit=await arrow();assert.equal(curveOrbit.points.length,3);assert.equal(curveOrbit.endBinding.mode,'orbit');await page.keyboard.down('Control');await page.waitForTimeout(75);assert.equal((await arrow()).endBinding.mode,'inside');await page.keyboard.up('Control');await page.waitForTimeout(75);assert.equal((await arrow()).endBinding.mode,'orbit');await page.mouse.up();await page.waitForTimeout(75);console.log('✓ 已有3点曲线实际端点拖拽与静止Ctrl切换');
await page.evaluate(()=>window.api.resetScene());assert.equal(await page.evaluate(()=>window.api.getAppState().shortArrowheads),true);assert.equal(await page.evaluate(()=>window.api.getAppState().arrowBindingOptimization),true);assert.deepEqual(errors,[]);console.log('✓ resetScene保持实例设置，浏览器无异常');

} finally {
  await browser?.close();
  if(server) await new Promise(done=>server.close(done));
  await rm(directory,{recursive:true,force:true});
}
