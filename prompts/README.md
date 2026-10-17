# Prompts

Gemini prompt files live here, one file per prompt.

- `testgen.md`: test generation (`generate` and `regenerate` sections), used by the
  test-generation Lambda.
- `transcribe.md`: transcription of a photographed answer (`transcribe` section), used by the
  Transcribe Lambda and `scripts/try-transcribe.ts`. The full text of `worker/DRIVERS.md` is
  inserted into it at `{{driversGuide}}`.

Each file is copied next to the Lambda bundle at build time and read at runtime. A section starts
at its `<!-- section: name -->` marker.
