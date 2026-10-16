#!/usr/bin/env node
// pnpm build:editor && CHROMIUM_PATH=/path/to/chrome node packages/excalidraw/tests/smartClipboard.browser.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve, dirname, extname } from "node:path";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import http from "node:http";

const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(packagePath, "../..");
const require = createRequire(resolve(root, "package.json"));
const packageRequire = createRequire(resolve(packagePath, "package.json"));
const { chromium } = require("@playwright/test");
const esbuild = packageRequire("esbuild");
const directory = await mkdtemp(resolve(tmpdir(), "excalidraw-smart-clipboard-"));
const screenshots = resolve(root, "test-results/smart-clipboard");
const servers = [];
let browser;
try {
  await esbuild.build({
    stdin: { contents: `
import React from ${JSON.stringify(packageRequire.resolve("react"))};
import {createRoot} from ${JSON.stringify(packageRequire.resolve("react-dom/client"))};
import {Excalidraw,convertToExcalidrawElements} from ${JSON.stringify(packagePath + "/dist/dev/index.js")};
import ${JSON.stringify(packagePath + "/dist/dev/index.css")};
import {parseClipboard,parseDataTransferEvent,createPasteEvent} from ${JSON.stringify(packagePath + "/clipboard.ts")};
import {readNativeClipboardHTML,createClipboardHTML,encodeNativeClipboard} from ${JSON.stringify(packagePath + "/smartClipboard.ts")};
window.core={parseClipboard,parseDataTransferEvent,createPasteEvent,readNativeClipboardHTML,createClipboardHTML,encodeNativeClipboard};
window.makeElements=specs=>convertToExcalidrawElements(specs,{regenerateIds:false});
createRoot(document.querySelector('#root')).render(<Excalidraw autoFocus langCode="zh-CN" initialData={{elements:[]}} onInitialize={api=>window.api=api}/>);
window.load=()=>{
 const elements=window.makeElements([
  {id:'frame',type:'frame',x:80,y:80,width:600,height:450,name:'Frame',children:['box','rich','image']},
  {id:'box',type:'rectangle',x:120,y:120,width:200,height:100,label:{text:'Bound label'}},
  {id:'rich',type:'text',x:120,y:270,text:'Bold link',fontSize:24},
  {id:'image',type:'image',x:420,y:130,width:80,height:60,fileId:'picture',status:'saved'},
 ]);
 const rich=elements.find(e=>e.id==='rich');
 rich.richText={version:2,doc:{type:'doc',content:[{type:'heading',attrs:{level:2},content:[{type:'text',text:'Bold',marks:[{type:'bold'}]}]},{type:'paragraph',content:[{type:'text',text:'link',marks:[{type:'italic'},{type:'link',attrs:{href:'https://example.test/?a=1&b=2'}}]}]}]}};
 rich.originalText='Bold\\nlink';rich.text='Bold\\nlink';rich.height=120;rich.width=220;
 for(const e of elements)if(e.id!=='frame')e.frameId='frame';
 const c=document.createElement('canvas');c.width=80;c.height=60;const ctx=c.getContext('2d');ctx.fillStyle='#0077cc';ctx.fillRect(0,0,80,60);
 window.api.addFiles([{id:'picture',mimeType:'image/png',dataURL:c.toDataURL(),created:Date.now()}]);
 window.api.updateScene({elements,appState:{selectedElementIds:{frame:true},selectedGroupIds:{},scrollX:0,scrollY:0,zoom:{value:1}}});
 return elements.length;
};
`, sourcefile: "entry.jsx", resolveDir: packagePath, loader: "jsx" },
    bundle: true, outfile: resolve(directory, "entry.js"), platform: "browser", format: "esm",
    loader: { ".woff2": "file", ".ttf": "file", ".png": "file", ".svg": "file" },
    define: { "process.env.NODE_ENV": '"development"', "import.meta.env": "{}" }, logLevel: "silent",
  });
  await writeFile(resolve(directory, "index.html"), '<!doctype html><html><head><link rel="stylesheet" href="/entry.css"></head><body style="margin:0"><div id="root" style="height:100vh"></div><script type="module" src="/entry.js"></script></body></html>');
  await writeFile(resolve(directory, "target.html"), '<!doctype html><html><head><meta charset="utf-8"></head><body><h1>智能复制：文档流图形与可编辑文字</h1><textarea id="plain" style="width:700px;height:80px"></textarea><div id="rich" contenteditable style="border:1px solid #999;min-height:500px;padding:16px"></div></body></html>');
  for (let i = 0; i < 2; i++) {
    const server = http.createServer(async (req, res) => {
      try {
        const path = resolve(directory, "." + (new URL(req.url, "http://localhost").pathname === "/" ? "/index.html" : new URL(req.url, "http://localhost").pathname));
        if (!path.startsWith(directory + "/")) throw new Error("invalid path");
        res.writeHead(200, { "Content-Type": { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" }[extname(path)] || "application/octet-stream" });
        res.end(await readFile(path));
      } catch (error) { console.warn("Fixture request unavailable", error.message); res.writeHead(404); res.end(); }
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    servers.push(server);
  }
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  console.log("Chromium", browser.version());
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"], viewport: { width: 1200, height: 900 } });
  await context.route("https://**", (route) => route.abort());
  const origin = (i) => `http://127.0.0.1:${servers[i].address().port}`;
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin(0));
  await page.waitForFunction(() => !!window.api);
  const count = await page.evaluate(() => window.load());
  const focus = async (p) => { await p.bringToFront(); await p.locator('.excalidraw-container').click({ position: { x: 750, y: 600 } }); };
  // Clicking empty canvas clears selection: re-select after focusing.
  await focus(page);
  await page.evaluate(() => window.api.updateScene({ appState: { selectedElementIds: { frame: true } } }));
  const read = () => page.evaluate(async () => {
    const result = {};
    for (const item of await navigator.clipboard.read()) for (const type of item.types)
      result[type] = type.startsWith('text/') ? await (await item.getType(type)).text() : 'binary';
    return result;
  });
  await page.keyboard.press("Control+c");
  await page.waitForFunction(async () => (await navigator.clipboard.readText()).includes('Bound label'));
  const copied = await read();
  assert.deepEqual(Object.keys(copied).sort(), ["text/html", "text/plain"]);
  assert.equal(copied['text/plain'], 'Bold\nlink\n\nBound label');
  assert.equal((copied['text/html'].match(/Bound label/g) || []).length, 1);
  assert.match(copied['text/html'], /<strong>Bold<\/strong>/);
  assert.match(copied['text/html'], /data:image\/png;base64,/);
  const native = await page.evaluate(html => window.core.readNativeClipboardHTML(html), copied['text/html']);
  assert.equal(native.elements.length, count);
  assert.equal(native.files.picture.mimeType, 'image/png');
  console.log('PASS actual native clipboard: plain + editable HTML + marker/files, no PNG representation');
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: resolve(screenshots, "source.png") });

  const target = await context.newPage();
  await target.goto(origin(1) + '/target.html');
  await target.locator('#plain').click(); await target.keyboard.press('Control+v');
  assert.equal(await target.inputValue('#plain'), copied['text/plain']);
  await target.locator('#rich').click(); await target.keyboard.press('Control+v');
  assert.equal(await target.locator('#rich img').count(), 1);
  await target.waitForFunction(()=>{const img=document.querySelector('#rich img');return img?.complete&&img.naturalWidth>0;});
  await target.locator('#rich').press('End');
  await target.keyboard.type(' editable');
  assert.ok((await target.locator('#rich').innerText()).includes('editable'));
  assert.equal(await target.locator('#rich strong').textContent(), 'Bold');
  assert.equal(await target.locator('#rich a').getAttribute('href'), 'https://example.test/?a=1&b=2');
  assert.equal((await target.locator('#rich').innerText()).match(/Bound label/g).length, 1);
  await target.screenshot({ path: resolve(screenshots, 'editable-document.png') });
  console.log('PASS actual cross-origin textarea/contenteditable paste (not Word/QQ/WeChat)');

  const receiver = await context.newPage();
  await receiver.goto(origin(1)); await receiver.waitForFunction(() => !!window.api);
  await focus(receiver); await receiver.keyboard.press('Control+v');
  await receiver.waitForFunction(n => window.api.getSceneElements().length === n, count);
  assert.equal(await receiver.evaluate(() => Object.keys(window.api.getFiles()).length), 1);
  assert.equal(await receiver.evaluate(() => window.api.getSceneElements().find(e => e.type==='text' && e.richText)?.richText.version), 2);
  assert.equal(await receiver.evaluate(() => window.api.getSceneElements().filter(e=>e.frameId).length), count - 1);
  assert.equal(await receiver.evaluate(()=>{const elements=window.api.getSceneElements();const label=elements.find(e=>e.type==='text'&&e.originalText==='Bound label');const container=elements.find(e=>e.id===label.containerId);return container?.boundElements.some(bound=>bound.id===label.id&&bound.type==='text');}),true);
  await receiver.screenshot({ path: resolve(screenshots, 'cross-origin-elements.png') });
  // Same native formats with an extra PNG must still paste native shapes, not a screenshot.
  await receiver.evaluate(async (copied) => {
    const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;
    const png=await new Promise(r=>canvas.toBlob(r));
    await navigator.clipboard.write([new ClipboardItem({'text/plain':new Blob([copied['text/plain']],{type:'text/plain'}),'text/html':new Blob([copied['text/html']],{type:'text/html'}),'image/png':png})]);
    window.api.updateScene({elements:[]});
  }, copied);
  await focus(receiver); await receiver.keyboard.press('Control+v');
  await receiver.waitForFunction(n=>window.api.getSceneElements().length===n,count);
  console.log('PASS native payload > accompanying PNG, cross-origin editable elements/files/richText/frame');
  await receiver.evaluate(()=>window.api.updateScene({elements:[]}));
  await receiver.keyboard.press('Control+Shift+v');
  await receiver.waitForFunction(()=>window.api.getSceneElements().length===1);
  assert.equal(await receiver.evaluate(()=>window.api.getSceneElements()[0].type), 'text');
  assert.equal(await receiver.evaluate(()=>window.api.getSceneElements()[0].originalText), copied['text/plain']);
  console.log('PASS smart Shift+V is plain text even when PNG accompanies it');

  await page.bringToFront();
  await page.evaluate(()=>window.api.updateScene({appState:{selectedElementIds:{frame:true}}}));
  await page.mouse.click(678,350,{button:'right'});
  const menu = page.locator('.context-menu');
  await menu.waitFor();
  assert.ok((await menu.innerText()).includes('智能复制'));
  assert.ok((await menu.innerText()).includes('原始 Excalidraw 兼容复制'));
  assert.ok((await menu.innerText()).includes('PNG'));
  await page.screenshot({path:resolve(screenshots,'copy-menu.png')});
  await page.evaluate(()=>navigator.clipboard.writeText('context-menu-sentinel'));
  await menu.getByText('智能复制',{exact:true}).click();
  await page.waitForFunction(async()=> (await navigator.clipboard.readText()).includes('Bound label'));
  assert.match((await read())['text/html'], /data-excalidraw-workspace/);
  await page.mouse.click(678,350,{button:'right'});
  await page.locator('.context-menu').getByText('原始 Excalidraw 兼容复制',{exact:true}).click();
  await page.waitForFunction(async()=> (await navigator.clipboard.readText()).startsWith('{"type":"excalidraw/clipboard"'));
  assert.equal(JSON.parse((await read())['text/plain']).type,'excalidraw/clipboard');
  console.log('PASS three context entries, async context-menu smart write, legacy compatible plain JSON');

  await focus(page);
  await page.evaluate(()=>window.api.updateScene({appState:{selectedElementIds:{frame:true}}}));
  await page.evaluate(async()=>{await navigator.clipboard.writeText('png-sentinel');window.pngWrites=[];window.pngWrite=navigator.clipboard.write.bind(navigator.clipboard);navigator.clipboard.write=items=>{window.pngWrites.push(items.map(i=>i.types));window.pngPending=window.pngWrite(items);return window.pngPending;};});
  await page.keyboard.press('Control+Shift+c');
  await page.waitForFunction(()=>!!window.pngPending);
  await page.evaluate(()=>window.pngPending);
  const pngRead=await read();
  assert.equal(pngRead['image/png'],'binary');
  assert.ok((await page.evaluate(()=>window.pngWrites)).every(items=>items.length===1&&items[0].includes('image/png')));
  await page.evaluate(()=>navigator.clipboard.write=window.pngWrite);
  console.log('PASS Ctrl+Shift+C remains PNG');

  // Permission failure is injected here; no native OS result is claimed for this case.
  await page.evaluate(()=>{
    window.realWrite=navigator.clipboard.write.bind(navigator.clipboard);
    navigator.clipboard.write=()=>Promise.reject(new DOMException('denied for regression','NotAllowedError'));
  });
  await page.keyboard.press('Control+x');
  await page.waitForFunction(()=>window.api.getAppState().errorMessage?.includes('denied'));
  assert.equal(await page.evaluate(()=>window.api.getSceneElements().length),count);
  await page.evaluate(()=>{navigator.clipboard.write=window.realWrite;window.api.updateScene({appState:{errorMessage:null}});});
  await page.locator('.excalidraw-modal-container').waitFor({state:'hidden'});
  console.log('PASS cut permission rejection retains original scene');
  // Character selection uses PM's native HTML, not the scene envelope.
  await focus(page);
  await page.evaluate(()=>{
    const rich=window.api.getSceneElements().find(e=>e.id==='rich');
    window.api.updateScene({elements:[{...rich,x:400,y:400,width:220,height:120,frameId:null}],appState:{selectedElementIds:{rich:true}}});
  });
  await page.mouse.dblclick(440,420);
  await page.locator('.excalidraw-wysiwyg strong').waitFor();
  await page.evaluate(()=>{const strong=document.querySelector('.excalidraw-wysiwyg strong');const range=document.createRange();range.selectNodeContents(strong);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);});
  await page.keyboard.press('Control+c');
  await page.waitForFunction(async()=>await navigator.clipboard.readText()==='Bold');
  const characters=await read();
  assert.match(characters['text/html'],/<strong>Bold<\/strong>/);
  assert.doesNotMatch(characters['text/html'],/data-excalidraw-workspace/);
  await target.bringToFront();
  await target.locator('#rich').fill('');
  await target.locator('#rich').click();await target.keyboard.press('Control+v');
  assert.equal(await target.locator('#rich strong').textContent(),'Bold');
  console.log('PASS native partial character copy preserves marks without whole-scene data');
  await focus(page);
  await page.evaluate(()=>window.api.updateScene({appState:{selectedElementIds:{rich:true}}}));
  await page.keyboard.press('Control+x');
  await page.waitForFunction(()=>window.api.getSceneElements().length===0);
  await page.keyboard.press('Control+z');
  await page.waitForFunction(()=>window.api.getSceneElements().length===1);
  console.log('PASS successful native text cut and undo');

  // Delay completion of a real write to test frame membership and scene-switch guards.
  await page.evaluate(()=>{
    window.load();window.normalWrite=navigator.clipboard.write.bind(navigator.clipboard);
    navigator.clipboard.write=async items=>{const gate=new Promise(resolve=>window.finishWrite=resolve);await window.normalWrite(items);await gate;};
  });
  await page.keyboard.press('Control+x');
  await page.waitForFunction(()=>!!window.finishWrite);
  await page.evaluate(()=>{
    const [child]=window.makeElements([{id:'new-child',type:'rectangle',x:350,y:300,width:40,height:40}]);
    child.frameId='frame';
    window.api.updateScene({elements:[...window.api.getSceneElements(),child]});window.finishWrite();
  });
  await page.waitForFunction(()=>window.api.getAppState().toast?.message.includes('未剪切'));
  assert.equal(await page.evaluate(()=>window.api.getSceneElements().length),count+1);
  await page.evaluate(()=>{window.finishWrite=null;window.api.updateScene({appState:{toast:null}});});
  await page.keyboard.press('Control+x');
  await page.waitForFunction(()=>!!window.finishWrite);
  const beforeSwitch=await page.evaluate(()=>window.api.getSceneElements().map(e=>[e.id,e.version,e.versionNonce]));
  await page.evaluate(()=>{window.api.updateScene({elements:structuredClone(window.api.getSceneElements())});window.finishWrite();});
  await page.waitForFunction(()=>window.api.getAppState().toast?.message.includes('未剪切'));
  assert.deepEqual(await page.evaluate(()=>window.api.getSceneElements().map(e=>[e.id,e.version,e.versionNonce])),beforeSwitch);
  await page.evaluate(()=>navigator.clipboard.write=window.normalWrite);
  console.log('PASS real write delayed completion: new frame child and switched scene are not deleted');

  const malformed = Buffer.from(JSON.stringify({type:'excalidraw-workspace/clipboard',version:1,data:{...native,elements:native.elements.map(e=>({...e,link:1}))}})).toString('base64');
  const parsed = await page.evaluate(async marker=>window.core.parseClipboard(await window.core.parseDataTransferEvent(window.core.createPasteEvent({types:{'text/plain':'safe fallback','text/html':`<div data-excalidraw-workspace="${marker}">safe fallback</div>`}}))),malformed);
  assert.equal(parsed.text,'safe fallback');assert.equal(parsed.elements,undefined);
  for (const invalid of [{type:'line',points:[]},{type:'rectangle',width:0,height:0},{type:'text',text:'',originalText:'visible'}]) {
    const data={type:'excalidraw/clipboard',elements:[{...native.elements.find(e=>e.type==='text'),id:'broken',richText:undefined,containerId:null,frameId:null,...invalid}],files:{}};
    const marker=Buffer.from(JSON.stringify({type:'excalidraw-workspace/clipboard',version:1,data})).toString('base64');
    const result=await page.evaluate(async marker=>window.core.parseClipboard(await window.core.parseDataTransferEvent(window.core.createPasteEvent({types:{'text/plain':'restorable fallback','text/html':`<div data-excalidraw-workspace="${marker}">restorable fallback</div>`}}))),marker);
    assert.equal(result.text,'restorable fallback');assert.equal(result.elements,undefined);
  }
  console.log('PASS malformed or restore-discarded native payload falls back to readable plain');
  assert.deepEqual(errors,[]);
  console.log('Screenshots:',screenshots);
} finally {
  await browser?.close();
  await Promise.all(servers.map(server=>new Promise(resolveClose=>server.close(resolveClose))));
  if (!directory.startsWith(resolve(tmpdir(), 'excalidraw-smart-clipboard-'))) throw new Error('Unexpected temporary path');
  await rm(directory,{recursive:true,force:true});
}
