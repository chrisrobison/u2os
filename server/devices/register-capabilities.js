// Populates a CapabilityRegistry with U2OS's initial semantic capability
// catalog -- the fixed vocabulary agents express intent in (docs/devices.md),
// mirroring how server/tools/register-all.js populates a ToolRegistry with
// the fixed tool catalog. Adding a new capability id is a one-line addition
// here, same as adding a new Tool subclass there.
import { CapabilityRegistry } from './capability-registry.js';

// privacy: public | personal | private | sensitive (server/policy/data-processing-policy.js's vocabulary).
// defaultAuthorization: always | autonomous | confirm | never (server/policy/policy-engine.js's vocabulary).
const CAPABILITIES = [
  // --- presentation / UI ----------------------------------------------
  {
    id: 'ui.render',
    description: 'Render structured content (a dashboard/card) on a display device.',
    inputSchema: { type: 'object', properties: { content: { type: 'object' } }, required: ['content'] },
    privacy: 'personal',
    defaultAuthorization: 'autonomous',
  },
  {
    id: 'ui.notify',
    description: 'Show a lightweight, non-blocking notification.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title'] },
    privacy: 'personal',
    defaultAuthorization: 'autonomous',
  },
  {
    id: 'ui.prompt',
    description: 'Ask the user a question and wait for a response (e.g. an approval).',
    inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
    privacy: 'personal',
    defaultAuthorization: 'autonomous',
  },
  // --- audio -------------------------------------------------------------
  {
    id: 'audio.play',
    description: 'Play audio (including synthesized speech) out loud.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: [] },
    privacy: 'personal',
    defaultAuthorization: 'autonomous',
  },
  {
    id: 'speech.say',
    description: 'Speak text aloud via text-to-speech.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    privacy: 'personal',
    defaultAuthorization: 'autonomous',
  },
  {
    id: 'audio.listen',
    description: 'Capture a bounded segment of audio for speech recognition.',
    inputSchema: { type: 'object', properties: { maxSeconds: { type: 'number' } }, required: [] },
    privacy: 'private',
    defaultAuthorization: 'confirm',
  },
  // --- camera / vision -----------------------------------------------------
  {
    id: 'image.capture',
    description: 'Capture a single still image from a camera.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    privacy: 'private',
    defaultAuthorization: 'confirm',
  },
  {
    id: 'video.stream',
    description: 'Reference a continuous live video stream (see the stream abstraction, docs/devices.md).',
    inputSchema: { type: 'object', properties: {}, required: [] },
    privacy: 'private',
    defaultAuthorization: 'confirm',
  },
  // --- presence / sensing --------------------------------------------------
  {
    id: 'motion.events',
    description: 'Subscribe to motion-detected events from a sensor/camera.',
    privacy: 'private',
    defaultAuthorization: 'autonomous',
  },
  {
    id: 'presence.detect',
    description: 'Report whether a person is currently present at a location.',
    privacy: 'private',
    defaultAuthorization: 'autonomous',
  },
  {
    id: 'temperature.read',
    description: 'Read the current temperature from an environmental sensor.',
    privacy: 'personal',
    defaultAuthorization: 'always',
  },
  // --- notification / output ------------------------------------------------
  {
    id: 'notification.send',
    description: 'Send a notification through whatever channel a device provides (push, desktop, etc).',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title'] },
    privacy: 'personal',
    defaultAuthorization: 'autonomous',
  },
];

export function createCapabilityRegistry() {
  const registry = new CapabilityRegistry();
  for (const capability of CAPABILITIES) registry.register(capability);
  return registry;
}
