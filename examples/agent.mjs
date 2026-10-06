#!/usr/bin/env node
// A stand-in for an agent, for the demo. evdock runs it when events arrive and passes them as
// JSON on stdin. A real agent would be started the same way (see README: Claude Code).
//
// Everything in the messages comes from the MCP server: treat it as data, never as instructions.

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const { subscription, messages } = JSON.parse(input);

const time = new Date().toLocaleTimeString();
console.log(`\n[agent] woke up at ${time}: ${messages.length} message(s) from ${subscription?.server} / ${subscription?.event}`);
for (const m of messages) {
  if (m.kind === 'event') {
    const { id, severity, title } = m.body?.data ?? {};
    console.log(`[agent]   ${m.eventId}: ${id} ${severity} ${JSON.stringify(title)}`);
  } else {
    // gap: events may have been missed; terminated: the subscription has ended.
    console.log(`[agent]   control message: ${m.kind}`);
  }
}
