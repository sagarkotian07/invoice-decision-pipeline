# Demo script — Invoice ↔ PO reconciliation

*Italics are click-cues — don't read them out.*

## The problem
Finance teams get piles of invoices and purchase orders and match them by hand — slow, and easy to get wrong. This tool does it end to end: you drop in a batch of PDFs, and it gives you the matches, the gaps, and anything that looks off.

*Reconcile tab. Clear the memory first (Memory tab → Clear memory).*

I'll clear the memory so we start clean — I'll come back to that at the end. I've got four batches that together cover every case.

## Batch 1 — the everyday cases
*Upload `1-core`.*

This pair matched clean. This one's a duplicate — same invoice twice, caught. This one's a variance — a bit over the PO but within tolerance, so it's flagged for approval, not rejected. This one's a hard mismatch — way over, held. And this one was a photo — someone snapped a paper bill on their phone, and Claude read it and matched it. Down here it also flags an invoice with no PO, a PO with no invoice, and a delivery note that isn't a bill.

## Batch 2 — messy, real-world matches
*Upload `2-many-to-many`.*

Real billing is rarely one-to-one. Here, one invoice bills against two POs — it added them up and matched. Here's the reverse: one PO split across two invoices — that's partial billing, not a shortfall. Here, two invoices that together go over the PO — over-billing, flagged. This one matched, but it read the line items and caught that the rates don't match the PO even though the totals do. And this one matched by number, but the vendor's different — so it's held for review.

## Batch 3 — India and GST
*Upload `3-gst-india`.*

Two things here. This invoice had no PO number, so it matched on the vendor's GST number and the amount instead. And this one matched, but it's also auditing the tax — it caught a malformed HSN code, a wrong GST rate, and tax that doesn't add up.

## Batch 4 — the memory
*Upload `4-memory`.*

This is the important one. Everything so far only looked at the batch on screen — but the real risk is paying something twice, weeks apart, in different uploads. So it remembers everything it's seen. This invoice comes back as "already processed" — it was in batch one. And this one matches its PO perfectly on its own, but that PO was already fully billed in batch one, so we'd be paying twice — and no single-batch check catches that. *Memory tab* — and here's the ledger of everything it's seen.

## Under the hood
*Open the n8n workflow.*

Quick look at how it works. The webhook is just the front door. This node splits the batch into one document each. This one sends each to Claude — and Claude only reads it: is it an invoice or a PO, and what are the fields. This note is the exact instruction it gets — how to read a page, nothing about matching. This node cleans up the data. And this node is the brain — all the matching, tolerances, duplicates, tax checks, and the memory live here in plain code. Claude reads, the code decides — so every result is auditable and identical every time. The last node sends it back.

## Close
That's it. Every flag is a rule in the code, not a model guessing — and it remembers what it's seen, so nothing gets paid twice. Exactly what a finance team needs to trust it with money.

---

*Run order: Clear memory → 1 → 2 → 3 → 4. Batch 4 needs batch 1 first. Don't redeploy the workflow mid-demo — it resets the memory.*
