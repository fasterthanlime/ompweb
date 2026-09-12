import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { getSessionGoal, setSessionAdvisorEnabled, getSessionAdvisorEnabled } = await jiti.import("./session-preferences.ts");
const tick = () => new Promise(resolve => setImmediate(resolve));

test("goal continues without a browser; stop wins at the turn boundary; stale completion cannot finish a replacement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-test-"));
  const previous = process.env.OMP_WEB_SESSION_PREFERENCES;
  process.env.OMP_WEB_SESSION_PREFERENCES = join(dir, "preferences.json");
  let listener;
  const prompts = [];
  const results = [];
  const proc = {
    isAlive: true,
    onFrame(fn) { listener = fn; return () => {}; },
    async waitReady() { return {}; },
    async negotiateProtocol() {},
    async sendCommand(command) {
      if (command.type === "get_state") return {sessionId: "test-goal", isStreaming: false, isCompacting: false};
      if (command.type === "prompt") prompts.push(command.message);
      return {};
    },
    sendFrame(frame) { results.push(frame); },
    async dispose() {},
  };
  const wrapper = new AgentSessionWrapper(proc, dir);
  wrapper.start();
  try {
    await wrapper.waitUntilReady();
    await wrapper.send({type:"prompt",message:"Set yourself a goal to finish all milestones"});
    listener({type:"host_tool_call",id:"empty",toolName:"set_goal",arguments:{objective:"  "}});
    assert.equal(results.at(-1).isError, true);
    assert.equal(await wrapper.send({type:"get_goal"}), null);
    listener({type:"host_tool_call",id:"create",toolName:"set_goal",arguments:{objective:"Finish all milestones"}});
    const first = await wrapper.send({type:"get_goal"});
    assert.equal(first.status, "active");
    assert.equal(getSessionGoal("test-goal").id, first.id);
    assert.equal(prompts.length, 1, "agent creation must not start a competing turn");
    assert.ok(results.at(-1).result.content[0].text.includes(first.id));
    listener({type:"host_tool_call",id:"replace",toolName:"set_goal",arguments:{objective:"Different scope"}});
    assert.equal(results.at(-1).isError, true);
    assert.equal((await wrapper.send({type:"get_goal"})).id, first.id);
    listener({type:"host_tool_call",id:"replace-explicit",toolName:"set_goal",arguments:{action:"replace",goalId:first.id,objective:"Updated user scope"}});
    const successor = await wrapper.send({type:"get_goal"});
    assert.notEqual(successor.id, first.id);
    assert.equal(successor.objective, "Updated user scope");
    assert.equal(prompts.length, 1, "replacement must not start a competing run");
    listener({type:"host_tool_call",id:"finish-old",toolName:"finish_goal",arguments:{goalId:first.id,status:"completed",summary:"obsolete"}});
    assert.equal(results.at(-1).isError, true);
    assert.equal((await wrapper.send({type:"get_goal"})).id, successor.id);
    const end = () => listener({type:"agent_end",isTerminal:true,messages:[{role:"assistant",stopReason:"stop"}]});
    end();
    await tick();
    assert.equal(prompts.length, 2, "normal final replies continue without SSE listeners");
    end();
    await wrapper.send({type:"abort"});
    await tick();
    assert.equal(prompts.length, 2, "Stop must cancel scheduled continuation");
    assert.equal((await wrapper.send({type:"get_goal"})).status, "paused");
    listener({type:"host_tool_call",id:"override-stop",toolName:"set_goal",arguments:{objective:"Keep going"}});
    assert.equal(results.at(-1).isError, true);
    assert.equal((await wrapper.send({type:"get_goal"})).status, "paused");
    listener({type:"host_tool_call",id:"clear-paused",toolName:"set_goal",arguments:{action:"clear",goalId:first.id}});
    assert.equal(results.at(-1).isError, true);
    assert.equal((await wrapper.send({type:"get_goal"})).status, "paused");
    listener({type:"host_tool_call",id:"inspect-goal",toolName:"get_goal",arguments:{}});
    const discovered = JSON.parse(results.at(-1).result.content[0].text);
    assert.equal(discovered.id, successor.id);
    assert.equal(discovered.pauseReason, "user");
    listener({type:"host_tool_call",id:"clear-no-consent",toolName:"set_goal",arguments:{action:"clear",goalId:discovered.id}});
    assert.equal(results.at(-1).isError, true);
    listener({type:"host_tool_call",id:"clear-requested",toolName:"set_goal",arguments:{action:"clear",goalId:discovered.id,userRequested:true}});
    assert.equal(await wrapper.send({type:"get_goal"}), null);
    const second = await wrapper.send({type:"set_goal",action:"start",objective:"Replacement"});
    listener({type:"host_tool_call",id:"stale",toolName:"finish_goal",arguments:{goalId:first.id,status:"completed",summary:"old result"}});
    assert.equal(results.at(-1).isError, true);
    assert.equal((await wrapper.send({type:"get_goal"})).status, "active");
    listener({type:"host_tool_call",id:"current",toolName:"finish_goal",arguments:{goalId:second.id,status:"blocked",summary:"Need a decision"}});
    end();
    await tick();
    assert.equal(prompts.length, 3, "blocked goal must settle rather than continue");
    assert.equal(getSessionGoal("test-goal").status, "blocked");
    setSessionAdvisorEnabled("test-goal", true);
    assert.equal(getSessionGoal("test-goal").summary, "Need a decision");
    listener({type:"host_tool_call",id:"clear-stale",toolName:"set_goal",arguments:{action:"clear",goalId:first.id}});
    assert.equal(results.at(-1).isError, true);
    assert.equal(getSessionGoal("test-goal").id, second.id);
    listener({type:"host_tool_call",id:"clear-current",toolName:"set_goal",arguments:{action:"clear",goalId:second.id}});
    assert.notEqual(results.at(-1).isError, true);
    assert.equal(getSessionGoal("test-goal"), null);
    assert.equal(getSessionAdvisorEnabled("test-goal"), true);
  } finally {
    await wrapper.destroyAndWait();
    if(previous === undefined) delete process.env.OMP_WEB_SESSION_PREFERENCES;
    else process.env.OMP_WEB_SESSION_PREFERENCES = previous;
    rmSync(dir,{recursive:true,force:true});
  }
});
