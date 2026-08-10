#!/usr/bin/env bash
# One-shot deploy for the Margin Explorer bridge v2.
#
#   bash scripts/deploy-margin-bridge-v2.sh
#
# PREREQUISITES (both must be true, and neither can be done non-interactively):
#   1. gcloud auth login          — the laptop token expires and cannot self-refresh
#   2. Azure VPN connected        — only needed for the post-deploy smoke test;
#                                   Cloud Run itself reaches SAP over public egress
#
# Deploys api/ to Cloud Run service `vieforce-hq-api` in asia-southeast1
# (project vieforce-vpi). There is no staging — this is direct to production.
# The Vercel front-end is NOT touched; no front-end files changed.
set -euo pipefail

SERVICE="vieforce-hq-api"
REGION="asia-southeast1"
PROJECT="vieforce-vpi"

cd "$(dirname "$0")/.."

echo "==> 1/4  Unit tests (no network needed)"
node api/lib/__tests__/margin_bridge_v2.test.js

echo
echo "==> 2/4  Capturing the currently-serving revision (for rollback)"
PREV=$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" \
  --format='value(status.traffic[0].revisionName)')
echo "    current revision: $PREV"
echo "    rollback command if needed:"
echo "      gcloud run services update-traffic $SERVICE --region $REGION --project $PROJECT --to-revisions $PREV=100"

echo
echo "==> 3/4  Deploying from source"
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --project "$PROJECT" \
  --quiet

URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" \
  --format='value(status.url)')
echo "    deployed: $URL"

echo
echo "==> 4/4  Live smoke test against the deployed revision"
# HQ_SERVICE_TOKEN is read from .env.local; never echoed.
TOKEN=$(grep -E '^HQ_SERVICE_TOKEN=' .env.local | cut -d= -f2- | tr -d '"'"'"' \r')
if [ -z "$TOKEN" ]; then
  echo "    HQ_SERVICE_TOKEN not found in .env.local — skipping live check."
  echo "    Deploy succeeded; verify manually in the dashboard."
  exit 0
fi

RESP=$(curl -fsS -H "Authorization: Bearer $TOKEN" \
  "$URL/api/margin-explorer?period=MTD&compare=pp&include=bridge,dissection")

node -e '
const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
const cb = d.dissection && d.dissection.canonical_bridge;
const o  = d.discount_overlay;
if (!cb || !cb.available) { console.error("FAIL: canonical_bridge unavailable:", cb && cb.reason); process.exit(1); }
const w = cb.window;
console.log("    windows        ", w.base_window.join(".."), "vs", w.compare_window.join(".."));
console.log("    shipping days  ", w.base_shipping_days, "vs", w.compare_shipping_days, "| like_for_like =", w.like_for_like);
console.log("    bars           ", "price", cb.price, "cost", cb.cost, "custmix", cb.customer_mix, "prodmix", cb.product_mix);
console.log("    delta          ", cb.delta, "| reconciles =", cb.reconciles);
console.log("    sign_stable    ", cb.mix_ordering.sign_stable, "| churn_dominated =", cb.mix_detail.churn_dominated);
console.log("    significance   ", cb.significance.available ? cb.significance.verdict : cb.significance.reason);
console.log("    discount/kg    ", o ? o.discount_per_kg : "n/a", "| GM/kg net", o ? o.gm_per_kg_net_of_discount : "n/a");
const sum = cb.price + cb.cost + cb.customer_mix + cb.product_mix;
if (!cb.reconciles || Math.abs(sum - cb.delta) > 2) { console.error("FAIL: bars do not reconcile"); process.exit(1); }
if (!w.like_for_like && w.compare_partial) { console.error("FAIL: windows not like-for-like"); process.exit(1); }
console.log("\n    LIVE SMOKE TEST PASSED");
' <<< "$RESP"

echo
echo "Done. If anything looks wrong, roll back with the command printed in step 2."
