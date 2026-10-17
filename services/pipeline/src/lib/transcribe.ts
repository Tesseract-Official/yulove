// What scripts/try-transcribe.ts shares with the Transcribe Lambda, so the script runs exactly
// the same prompt, Gemini client and checks.
export { createGeminiClient, type GeminiClient, type GenerateJsonRequest } from './gemini.js';
export { loadPromptFile } from './prompt.js';
export {
  BUSY_MESSAGE,
  buildTranscribePrompt,
  checkTranscription,
  transcribeImage,
  type TranscriptionVerdict,
} from './transcription.js';
