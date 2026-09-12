import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
const {LiveCapture,AudioCaptureError}=await createJiti(import.meta.url).import('./dictation-live-capture.ts');
function environment(t,mode){
 const previous={AudioContext:globalThis.AudioContext,AudioWorkletNode:globalThis.AudioWorkletNode};let count=0;const contexts=[];
 class Context {
  state='running';generation=++count;reset=false;audioWorklet={addModule:async()=>{}};destination={};
  constructor(){contexts.push(this)}
  get currentTime(){return mode==='always-stalled'||(mode==='rebuild'&&this.generation===1)|| (mode==='resume'&&!this.reset)?0:performance.now()/1000}
  createMediaStreamSource(){return {connect(){},disconnect(){}}}
  async resume(){this.state='running'}async suspend(){this.reset=true;this.state='suspended'}async close(){this.state='closed'}
 }
 globalThis.AudioContext=Context;
 globalThis.AudioWorkletNode=class{port={close(){}};connect(){}disconnect(){}};
 t.after(()=>Object.assign(globalThis,previous));return contexts;
}
test('frozen foreground graph is rebuilt once, using the same stream',async t=>{const contexts=environment(t,'rebuild');const c=new LiveCapture();await c.start({});assert.equal(contexts.length,2);assert.equal(contexts[0].state,'closed');assert.equal(c.diagnostics().graphRebuilt,true);assert.ok(c.diagnostics().audioTime>0);c.cancel();assert.equal(contexts[1].state,'closed')});
test('engine that cannot recover fails bounded instead of declaring recording',async t=>{const contexts=environment(t,'always-stalled');const c=new LiveCapture();await assert.rejects(c.start({}),AudioCaptureError);assert.equal(contexts.length,2);c.cancel();assert.ok(contexts.every(c=>c.state==='closed'))});
test('suspend/resume recovery does not create another context',async t=>{const contexts=environment(t,'resume');const c=new LiveCapture();await c.start({});assert.equal(contexts.length,1);assert.equal(c.diagnostics().clockReset,true);assert.equal(c.diagnostics().graphRebuilt,false);c.cancel()});
