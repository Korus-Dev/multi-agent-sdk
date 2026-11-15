import { expect, it } from 'vitest';
import { harnesses } from '../../src/harnesses';

// The app's hook for titling MCP calls reaches each harness that shows MCP calls.
const presentToolCall = () => 'Title';
const options = { client: { name: 'app' }, presentToolCall };

it('hands the hook to Claude', () => {
  expect(harnesses.claude.mapOptions(options).claude?.host?.toolOptions?.presentToolCall).toBe(presentToolCall);
});

it('hands the hook to Cursor', () => {
  expect(harnesses.cursor.mapOptions(options).cursor?.sessionOptions?.presentToolCall).toBe(presentToolCall);
});

it('leaves everything as it was without a hook', () => {
  expect(harnesses.claude.mapOptions({ client: { name: 'app' } }).claude?.host).not.toHaveProperty('toolOptions');
  expect(harnesses.cursor.mapOptions({ client: { name: 'app' } }).cursor?.sessionOptions).not.toHaveProperty('presentToolCall');
});
