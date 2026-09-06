# Product

## Register

product

## Users

VieForce HQ is the executive sales, margin, AR and inventory dashboard of Vienovo Philippines Inc. (VPI), an animal-feed manufacturer. It reads live SAP Business One data.

Primary user: the CEO, reading the dashboard on a laptop or a large monitor during the working day, often between meetings, sometimes on a phone. The EVP Sales, finance leads and directors use the same screens. Field roles (RSM, DSM) will get scoped views later.

Context: the user already knows the business. They open a page to answer one question fast ("why did GM/ton move", "which customer is thin", "what is overdue"), then drill into the evidence behind the number. They do not want to be sold the product; they want to trust the figure and get to the next question.

## Product Purpose

Turn SAP B1 postings into decisions: unit margin, volume, price versus cost, customer and product mix, receivables and dispatch speed, all in pesos and tons, reconciled to the source. Success is an executive who checks a number here and acts on it without opening SAP or asking Finance to rebuild it in Excel.

The Margin Explorer pages exist to explain movement in gross margin per ton with an exact bridge (price, cost, customer mix, product mix) and to expose the invoice lines behind every cell.

## Brand Personality

Vienovo brand, VieForce sub-brand. Three words: precise, calm, accountable.

Tone: financial-report plain English. Numbers carry the message; the interface stays quiet around them. Caveats are stated once, close to the figure, never as marketing copy. Filipino-English business register: "tons", "PHP/t", "GP", "GM/t".

## Anti-references

- Generic SaaS analytics templates: hero metric with gradient accent, identical card grids, decorative glass and glow.
- Marketing-style headlines inside a working tool ("Twelve months. Every angle."). Panels are named by what they contain.
- Consumer fintech playfulness. No mascots, confetti, orchestrated page-load animation.
- Dashboards that hide the definition of a number. Every rate says its denominator and window.

## Design Principles

1. The number first, the chrome second. Tables and bridges get the space; headers, labels and controls stay small and out of the way.
2. One definition per figure. Scope (item group 103), unit (PHP/t), window (dates) and basis (reported or net of document discount) are visible wherever a figure is shown.
3. Drill, do not decorate. Every element that looks clickable drills into evidence; nothing is clickable only for effect.
4. Match the shell. New pages reuse the VieForce HQ tokens, type stack, table treatment and interaction states so the whole app reads as one tool.
5. Say what is uncertain. Estimates, partial months and unstable splits are flagged in place, in plain words, not hidden in footnotes.

## Accessibility & Inclusion

WCAG AA contrast in both dark and light themes (the shell already tunes `--text3` and `--text4` for it). Keyboard reachable controls with visible focus. Reduced-motion respected. Dense data is acceptable on desktop; on phones, tables scroll inside their panel and never the page. Colour is never the only carrier of sign: negative values also print a minus.
