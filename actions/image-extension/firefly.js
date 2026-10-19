// firefly.js — the Firefly Services calls used by Image Extension, as
// documented by Adobe (Firefly API tutorials / async guide):
//
//   POST https://firefly-api.adobe.io/v2/storage/image          upload -> images[0].id
//   POST https://firefly-api.adobe.io/v3/images/expand-async    -> { jobId, statusUrl, cancelUrl }
//   GET  https://firefly-api.adobe.io/v3/status/<jobId>         -> { status, result: { outputs[0].image.url, size } }
//
// Headers: X-Api-Key (client id) + Authorization: Bearer <IMS token>.
// (The synchronous v3 expand endpoint was removed on 2025-10-03 — async only.)

const FIREFLY_BASE = "https://firefly-api.adobe.io";
const MAX_SIDE = 2688; // Expand output limit per side
// Firefly async job id, e.g. "urn:ff:jobs:<region>:<uuid>". Strict charset:
// no "/", "?", "#", "%" — it is placed into the status URL path.
const JOB_ID = /^urn:ff:jobs:[A-Za-z0-9._:-]{1,200}$/;

function assertJobId(jobId) {
    if (typeof jobId !== "string" || !JOB_ID.test(jobId)) throw new Error("invalid Firefly jobId");
}

function createFireflyClient({ fetch, getAccessToken, clientId }) {
    async function headers(extra) {
        return Object.assign({ "X-Api-Key": clientId, "Authorization": `Bearer ${await getAccessToken()}` }, extra || {});
    }

    async function failure(res, what) {
        let detail = "";
        try {
            const j = await res.json();
            detail = j.message || j.error_code || j.error || "";
        } catch (e) { /* no JSON body */ }
        return new Error(`${what} failed (HTTP ${res.status}${detail ? ": " + detail : ""})`);
    }

    // Uploads image bytes to Firefly storage. Returns the upload id.
    async function uploadImage(bytes, contentType) {
        const res = await fetch(`${FIREFLY_BASE}/v2/storage/image`, {
            method: "POST",
            headers: await headers({ "Content-Type": contentType }),
            body: bytes,
        });
        if (!res.ok) throw await failure(res, "Firefly image upload");
        const json = await res.json();
        const id = json && json.images && json.images[0] && json.images[0].id;
        if (!id) throw new Error("Firefly image upload returned no id");
        return id;
    }

    // Submits Generative Expand. placement.inset positions the (already
    // working-size) source inside the requested canvas — its box is exactly
    // the source size, so the original is neither moved nor rescaled.
    //   size: {width, height}; inset: {top, right, bottom, left}
    //   prompt: optional text guiding the generated area (ExpandImageRequest.prompt, ≤ 1024 chars)
    async function submitExpand({ uploadId, size, inset, prompt }) {
        const body = {
            numVariations: 1,
            size: { width: size.width, height: size.height },
            image: { source: { uploadId } },
            placement: { inset: { left: inset.left, top: inset.top, right: inset.right, bottom: inset.bottom } },
        };
        if (prompt) body.prompt = prompt;
        const res = await fetch(`${FIREFLY_BASE}/v3/images/expand-async`, {
            method: "POST",
            headers: await headers({ "Content-Type": "application/json" }),
            body: JSON.stringify(body),
        });
        if (!res.ok) throw await failure(res, "Firefly expand-async");
        const json = await res.json();
        if (!json.jobId) throw new Error("Firefly expand-async returned no jobId");
        // requestBody: the exact JSON sent (no credentials in it) — for verification logs.
        // statusUrl: Firefly's own URL, for logging only (never fetched as given).
        return { jobId: json.jobId, statusUrl: json.statusUrl || null, requestBody: body };
    }

    // The status endpoint is built server-side from a validated job id —
    // a client-supplied URL is never fetched with our token. (Firefly's own
    // statusUrl may point at a dynamic host such as firefly-epoXXXX.adobe.io;
    // it is kept for logging only.)
    function statusUrlForJob(jobId) {
        assertJobId(jobId);
        return `${FIREFLY_BASE}/v3/status/${jobId}`;
    }

    // Reads a job's status from the canonical endpoint. Returns a normalized object:
    //   { status: "running"|"succeeded"|"failed"|…, jobId, outputUrl?, size?, error? }
    async function getJobStatus(jobId) {
        const url = statusUrlForJob(jobId);
        const res = await fetch(url, { method: "GET", headers: await headers() });
        if (!res.ok) throw await failure(res, "Firefly job status");
        const json = await res.json();
        const out = { status: String(json.status || "unknown").toLowerCase(), jobId: json.jobId || jobId };
        if (out.status === "succeeded") {
            const o = json.result && json.result.outputs && json.result.outputs[0];
            out.outputUrl = o && o.image && o.image.url ? o.image.url : null;
            out.size = (json.result && json.result.size) || null;
            if (!out.outputUrl) { out.status = "failed"; out.error = "succeeded without an output URL"; }
        } else if (out.status === "failed") {
            out.error = (json.error && (json.error.message || json.error.error_code)) || json.message || "Firefly job failed";
        }
        return out;
    }

    return { uploadImage, submitExpand, getJobStatus, statusUrlForJob };
}

module.exports = { createFireflyClient, assertJobId, JOB_ID, FIREFLY_BASE, MAX_SIDE };
