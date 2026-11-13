# Evidence blocks and citation previews

The reader keeps saved answers, prompts and source IDs immutable. This change affects the context for new questions and derives previews for existing citations at read time. It does not migrate the database or regenerate past answers.

## Context for new questions

`pageEvidenceBlocks()` maps native/OCR runs to offsets in the original page text. Explicit section, theorem, proof and note boundaries take precedence over physical line and paragraph boundaries. Page numbers and figure captions have distinct roles. Long positioned equations are not split at arbitrary character counts. The block index is cached by immutable page objects and its IDs include text/layout versions.

`selectEvidence()` starts from the actual selected coordinates, adds a complementary theorem/proof when appropriate, and retrieves a small set of relevant blocks. Informative content matches, complete phrases, section IDs and inverse document frequency guide ranking. Common question words, notes and figure captions receive less weight. Caption-only matches do not enter ordinary mathematical questions. Containment and text-range overlap prevent nested windows becoming separate sources.

There is no additional 1400-character nearby window. New sources retain `id`, `page`, `text` and `rects`, with optional `blockId`, `label` and `textRange` metadata. The selected text remains S1. Input budgets, attachment handling, inherited history and retry snapshots retain their existing behavior.

## Citation previews

New sources preview their stored evidence coordinates. Existing large sources are matched to blocks contained in their original text. The surrounding answer paragraph helps rank these blocks; near ties show multiple related pieces. A clipped historical proof is explicitly marked as an excerpt. The original source remains available in a collapsed disclosure.

Each spatially separated group gets its own crop and locate action. Sparse page numbers cannot inflate a caption into a page-sized image. Adjacent proof-ending marks stay with the proof. Raster cache entries contain only image blobs; each citation retains its own anchor even if two crops have identical outer bounds. Preview generation does not issue a model request or save the project.

The answer footer distinguishes sources actually cited in the answer from all material provided to the model. Repeated markers count once in this summary. The saved Markdown is not rewritten.

## Regression case

An offline replay of the existing “一致有界” question changes reference text from 3375 to 525 characters, and the full prompt from 3933 to 1239 characters. The resulting evidence consists of the selected term, T9's premise (184 characters), T9's proof (223 characters), and T5's proof containing the AA prerequisite (114 characters). The caption on page 6 is excluded. The entire input project is compared before and after to verify that the replay does not change saved data.

## Limits

Segmentation is deterministic and uses the available text/layout data; it is not a universal theorem parser. Unrecognized layouts, unusual reading order and inaccurate OCR may need text fallback or several preview pieces. A related paragraph is not a proof that every generated assertion is entailed by that paragraph. Original records remain available for verification. Mathematical operators and case are retained when deduplicating evidence.
