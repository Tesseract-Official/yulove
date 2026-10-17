# Fonts for the exam PDF

DejaVu Sans, DejaVu Sans Bold and DejaVu Sans Mono (from the Debian `fonts-dejavu` packages). They
cover the symbols that appear in constraints (≤, ≥, ×, →, ∈ and so on) and most scripts, which
PDFKit's built-in Helvetica and Courier cannot print. The licence is in `LICENSE.txt` and must travel
with the fonts.

The files are copied next to the API Lambda that renders the PDF (see `infra/src/routes.ts`).
