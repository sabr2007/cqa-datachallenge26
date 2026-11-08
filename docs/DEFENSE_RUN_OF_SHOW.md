# Five-minute defense run of show

Use the deployed CQA app and keep the FBroker list open before the judges arrive. The guide gives a five-minute defense plan; this sequence follows it.

| Time | Show | Say |
| --- | --- | --- |
| 0:00–0:40 | FBroker dialog list | “CQA reviews Freedom support conversations against the supplied checklist. It handles Russian, Kazakh, and English chats.” |
| 0:40–1:45 | Open `p2-kz-003` | Show the operator’s exact line proposing a personal transfer, then the critical flag. Explain that evidence links back to the transcript. |
| 1:45–2:35 | Show a normal criterion and an N/A criterion | Explain that the models return criterion decisions and evidence; application code validates evidence and calculates the weighted score, including N/A redistribution. |
| 2:35–3:25 | Show agreement and review status | “Three different models vote per criterion. Disagreement or unsupported evidence is surfaced for a person. We reviewed the four flagged FBroker chats and agree with the decisions.” |
| 3:25–4:15 | Checklist editor and appeal/reviewer flow | Show that checklist criteria are configurable and versioned. If asked, demonstrate the appeal and reviewer path using a clearly labeled demo record. |
| 4:15–5:00 | Live SWAP check or close | If requested, load `Swap`, evaluate the three chats, and call it a supplementary live check—not an expert-validated accuracy result. Otherwise close with evidence, auditability, and Dynamics 365 integration. |

## What differentiates this solution

- Three model families vote, so agreement is checked across different models rather than repeated samples from one model.
- Every criterion has a reason and transcript evidence; evidence is checked before it affects scoring.
- Scoring and N/A weight redistribution are deterministic code, not free-form model totals.
- The workflow covers reviewers, appeals, versioned checklists, and a Dynamics 365-oriented integration.
- The 60-chat DEV benchmark reports 95.8% agreement overall and 93.1% on 20 held-out chats. FBroker has no supplied gold labels, so its scores are predictions, not an accuracy measurement.

Be candid about cost: the ensemble is about $0.155 per chat. Position it around traceability, review workflow, and cross-model agreement, not lowest cost.

## Run SWAP live

1. In **Диалоги**, enter the exact group ID `Swap` in the **Набор** field and press Enter.
2. Confirm the list shows **3 диалогов** (RU, KZ, EN).
3. Choose **Оценить набор** → **Неоценённые (3)** → leave the default models selected → start evaluation.
4. Review one result and its evidence. State clearly that this is a live supplementary check; no gold labels were supplied for SWAP.

Keep the SWAP run and its evaluation history. Do not remove results to make the demo appear more favorable.
