#!/usr/bin/env node
/**
 * SoulStruck — assign the "Choose Your Kit" images to their variants.
 *
 * WHY THIS EXISTS
 * ---------------
 * The theme already shows a variant's image as the active gallery slide:
 * snippets/product-media-gallery-content.liquid moves `variant.featured_media`
 * to position 0 and appends every other product photo after it. It is rendered
 * server-side, so it also survives the gallery replacing itself on variant change
 * (assets/media-gallery.js). The only thing missing is the data — 317 of 318 kit
 * variants have no image assigned.
 *
 * This script fills that gap: for every product with a "Choose Your Kit" option it
 * attaches the two kit images to the product's media (once) and points each variant
 * at the matching one. Doing it through Shopify's own variant-image field — rather
 * than a theme hack — also fixes the cart line thumbnail, the mini-cart image, and
 * the product-card image swap in assets/ss-variant-cards.js, all for free.
 *
 * USAGE
 * -----
 *   export SHOPIFY_STORE=zc7v1u-1r.myshopify.com
 *   export SHOPIFY_ADMIN_TOKEN=shpat_xxxxxxxx      # custom app, scopes: read_products, write_products
 *
 *   node scripts/assign-kit-variant-images.mjs                      # dry run, whole catalogue
 *   node scripts/assign-kit-variant-images.mjs --handle 24k-luxe    # dry run, one product
 *   node scripts/assign-kit-variant-images.mjs --handle 24k-luxe --apply
 *   node scripts/assign-kit-variant-images.mjs --limit 5 --apply    # first 5, then check the storefront
 *   node scripts/assign-kit-variant-images.mjs --apply              # the rest
 *
 * It is a dry run unless you pass --apply, and it is idempotent: a variant that
 * already points at the right image is skipped, and the kit image is uploaded to a
 * product only once. Re-running after a partial run is safe.
 *
 * Requires Node 18+ (built-in fetch). No dependencies.
 */

/* ------------------------------------------------------------------ config -- */

/** Option value -> image. Keys are compared case-insensitively.
 *  'signatute edit' is a typo that exists on the `fruit-punch` product; it is
 *  mapped here so the run does not skip it. Fix the option value in admin and the
 *  entry becomes dead weight you can delete. */
const KIT_IMAGES = {
  'signature edit': {
    url: 'https://cdn.shopify.com/s/files/1/0798/4726/0384/files/signature-edit_be2192d2-583c-42a2-864a-a4dc432e9b4c.jpg?v=1788118138',
    alt: 'Signature Edit kit contents',
  },
  'signatute edit': {
    url: 'https://cdn.shopify.com/s/files/1/0798/4726/0384/files/signature-edit_be2192d2-583c-42a2-864a-a4dc432e9b4c.jpg?v=1788118138',
    alt: 'Signature Edit kit contents',
  },
  'pocket edit': {
    url: 'https://cdn.shopify.com/s/files/1/0798/4726/0384/files/pocket-edit_5a907aca-b72a-40c0-a6f8-7486bd8f3ae0.jpg?v=1788118138',
    alt: 'Pocket Edit kit contents',
  },
};

const OPTION_NAME = 'choose your kit';

/* -------------------------------------------------------------------- args -- */

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};

const APPLY = has('--apply');
const HANDLE = valueOf('--handle');
const LIMIT = valueOf('--limit') ? Number(valueOf('--limit')) : Infinity;

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

if (!STORE || !TOKEN) {
  console.error('Set SHOPIFY_STORE and SHOPIFY_ADMIN_TOKEN first. See the header of this file.');
  process.exit(1);
}

/* ----------------------------------------------------------------- client -- */

/** Shopify drops old API versions, so ask the shop which ones it serves today. */
async function latestApiVersion() {
  const res = await fetch(`https://${STORE}/admin/api/api_versions.json`, {
    headers: { 'X-Shopify-Access-Token': TOKEN },
  });
  if (!res.ok) throw new Error(`Could not list API versions (HTTP ${res.status}). Check the store domain and token.`);
  const { api_versions: versions } = await res.json();
  const stable = versions.filter((v) => /^\d{4}-\d{2}$/.test(v.handle)).map((v) => v.handle).sort();
  const picked = stable.at(-1);
  if (!picked) throw new Error('No stable API version returned by the shop.');
  return picked;
}

let endpoint;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GraphQL call with retry on throttling and 5xx. */
async function gql(query, variables = {}, attempt = 1) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 429 || res.status >= 500) {
    if (attempt > 6) throw new Error(`Giving up after ${attempt} attempts (HTTP ${res.status}).`);
    await sleep(1000 * 2 ** (attempt - 1));
    return gql(query, variables, attempt + 1);
  }

  const body = await res.json();

  // Cost-based throttling comes back as a 200 with an error code.
  if (body.errors?.some((e) => e.extensions?.code === 'THROTTLED')) {
    if (attempt > 6) throw new Error('Still throttled after 6 attempts.');
    await sleep(1000 * 2 ** (attempt - 1));
    return gql(query, variables, attempt + 1);
  }

  if (body.errors) throw new Error(JSON.stringify(body.errors, null, 2));
  return body.data;
}

/* ---------------------------------------------------------------- queries -- */

const PRODUCTS = `
  query Products($cursor: String, $query: String) {
    products(first: 20, after: $cursor, query: $query, sortKey: ID) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        title
        options { name values }
        media(first: 100) {
          nodes { ... on MediaImage { id alt status image { url } } }
        }
        variants(first: 100) {
          nodes {
            id
            title
            image { url }
            selectedOptions { name value }
          }
        }
      }
    }
  }`;

const CREATE_MEDIA = `
  mutation CreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media { ... on MediaImage { id alt status } }
      mediaUserErrors { field message }
    }
  }`;

const MEDIA_STATUS = `
  query MediaStatus($ids: [ID!]!) {
    nodes(ids: $ids) { ... on MediaImage { id status image { url } } }
  }`;

const ASSIGN = `
  mutation Assign($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id title image { url } }
      userErrors { field message }
    }
  }`;

/* ------------------------------------------------------------------ helpers - */

const norm = (s) => (s || '').trim().toLowerCase();

function kitValueOf(variant) {
  const opt = variant.selectedOptions.find((o) => norm(o.name) === OPTION_NAME);
  return opt ? norm(opt.value) : null;
}

/** Media already on the product for this kit, matched on the alt we write. */
function existingMediaFor(product, spec) {
  return product.media.nodes.find((m) => m?.id && norm(m.alt) === norm(spec.alt));
}

/** Newly created media is processed asynchronously; a variant cannot point at it
 *  until Shopify reports READY. */
async function waitForReady(ids, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const { nodes } = await gql(MEDIA_STATUS, { ids });
    const failed = nodes.filter((n) => n?.status === 'FAILED');
    if (failed.length) throw new Error(`Media processing FAILED for ${failed.map((f) => f.id).join(', ')}`);
    if (nodes.every((n) => n?.status === 'READY')) return;
    await sleep(1500);
  }
  throw new Error('Timed out waiting for media to finish processing.');
}

/* --------------------------------------------------------------------- run -- */

async function main() {
  const version = await latestApiVersion();
  endpoint = `https://${STORE}/admin/api/${version}/graphql.json`;

  console.log(`store        ${STORE}`);
  console.log(`api version  ${version}`);
  console.log(`mode         ${APPLY ? 'APPLY (writes to your live catalogue)' : 'DRY RUN (no writes)'}`);
  if (HANDLE) console.log(`handle       ${HANDLE}`);
  if (LIMIT !== Infinity) console.log(`limit        ${LIMIT} product(s)`);
  console.log('');

  const stats = { scanned: 0, changed: 0, uploaded: 0, assigned: 0, skipped: 0, unmapped: new Set(), errors: 0 };
  let cursor = null;
  let processed = 0;

  outer: while (true) {
    const data = await gql(PRODUCTS, { cursor, query: HANDLE ? `handle:${HANDLE}` : null });
    const { nodes, pageInfo } = data.products;

    for (const product of nodes) {
      const hasKitOption = product.options.some((o) => norm(o.name) === OPTION_NAME);
      if (!hasKitOption) continue;

      stats.scanned++;
      if (processed >= LIMIT) break outer;

      // 1. Which variants actually need an image?
      const todo = [];
      for (const variant of product.variants.nodes) {
        const value = kitValueOf(variant);
        if (!value) continue;

        const spec = KIT_IMAGES[value];
        if (!spec) {
          stats.unmapped.add(`${product.handle}: "${value}"`);
          continue;
        }
        if (variant.image?.url) {
          stats.skipped++;
          continue;
        }
        todo.push({ variant, spec });
      }

      if (!todo.length) continue;
      processed++;
      stats.changed++;

      const wanted = [...new Set(todo.map((t) => t.spec.alt))];
      console.log(`${product.handle}`);

      try {
        // 2. Attach any kit image the product does not have yet.
        const mediaByAlt = new Map();
        const toUpload = [];

        for (const alt of wanted) {
          const spec = todo.find((t) => t.spec.alt === alt).spec;
          const found = existingMediaFor(product, spec);
          if (found) mediaByAlt.set(alt, found.id);
          else toUpload.push(spec);
        }

        if (toUpload.length) {
          console.log(`   upload   ${toUpload.map((s) => s.alt).join(', ')}`);
          if (APPLY) {
            const res = await gql(CREATE_MEDIA, {
              productId: product.id,
              media: toUpload.map((s) => ({
                originalSource: s.url,
                alt: s.alt,
                mediaContentType: 'IMAGE',
              })),
            });
            const errs = res.productCreateMedia.mediaUserErrors;
            if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));

            const created = res.productCreateMedia.media;
            await waitForReady(created.map((m) => m.id));
            for (const m of created) mediaByAlt.set(norm(m.alt), m.id);
            // keep both spellings addressable
            for (const m of created) mediaByAlt.set(m.alt, m.id);
            stats.uploaded += created.length;
          } else {
            for (const s of toUpload) mediaByAlt.set(s.alt, '<new-media-id>');
          }
        }

        // 3. Point each variant at its kit image.
        const variants = todo.map(({ variant, spec }) => ({
          id: variant.id,
          mediaId: mediaByAlt.get(spec.alt) ?? mediaByAlt.get(norm(spec.alt)),
        }));

        for (const { variant, spec } of todo) {
          console.log(`   assign   ${variant.title.padEnd(16)} -> ${spec.alt}`);
        }

        if (APPLY) {
          const res = await gql(ASSIGN, { productId: product.id, variants });
          const errs = res.productVariantsBulkUpdate.userErrors;
          if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
          stats.assigned += variants.length;
        } else {
          stats.assigned += variants.length;
        }
      } catch (err) {
        stats.errors++;
        console.log(`   ERROR    ${err.message}`);
      }
    }

    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }

  console.log('\n----------------------------------------');
  console.log(`products with a kit option   ${stats.scanned}`);
  console.log(`products needing changes     ${stats.changed}`);
  console.log(`images uploaded              ${stats.uploaded}${APPLY ? '' : ' (dry run)'}`);
  console.log(`variant assignments          ${stats.assigned}${APPLY ? '' : ' (dry run)'}`);
  console.log(`variants already done        ${stats.skipped}`);
  console.log(`errors                       ${stats.errors}`);
  if (stats.unmapped.size) {
    console.log(`\nUnmapped option values (add them to KIT_IMAGES or fix them in admin):`);
    for (const u of stats.unmapped) console.log(`   ${u}`);
  }
  if (!APPLY) console.log('\nDry run only. Re-run with --apply to write.');
}

main().catch((err) => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
