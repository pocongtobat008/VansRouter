// OpenAI-compatible embeddings adapter (most providers)
import { bearerAuth } from "./_base.js";
import { PROVIDER_MEDIA } from "../../providers/index.js";

// media-only providers without a registry file keep URL here; rest derive from registry media.embeddingConfig.baseUrl
const ENDPOINTS = {
  "jina-ai": "https://api.jina.ai/v1/embeddings",
};

const embedCfg = (id) => PROVIDER_MEDIA[id]?.embeddingConfig || {};
const embedUrl = (id) => embedCfg(id).baseUrl || ENDPOINTS[id];

// Providers whose OpenAI-compatible /v1/embeddings endpoint rejects the
// `dimensions` body field (422 extra_forbidden). Per the embeddings skill doc,
// `dimensions` is only supported on OpenAI v3 models (text-embedding-3-*);
// Mistral (mistral-embed) rejects it outright, which previously bricked every
// account marked "unavailable" with [422] extra_forbidden body.dimensions.
const DIMENSIONS_UNSUPPORTED_PROVIDERS = new Set(["mistral"]);

export default function createOpenAIEmbeddingAdapter(providerId) {
  const cfg = embedCfg(providerId);
  const supportsDimensions = !DIMENSIONS_UNSUPPORTED_PROVIDERS.has(providerId);
  return {
    buildUrl: () => embedUrl(providerId),
    buildHeaders: (creds) => {
      return { "Content-Type": "application/json", ...bearerAuth(creds), ...(cfg.headers || {}) };
    },
    buildBody: (model, { input, encoding_format, dimensions }) => {
      const body = { model, input };
      if (encoding_format) body.encoding_format = encoding_format;
      if (supportsDimensions && dimensions != null && dimensions !== "") {
        const dim = Number(dimensions);
        if (Number.isFinite(dim) && dim > 0) body.dimensions = dim;
      }
      return body;
    },
    normalize: (responseBody) => responseBody,
  };
}
