// Repository manifests are the single list of indexed networks for tools and tests.
const fs = require("node:fs");
const path = require("node:path");
const { createRuntimeRequire } = require("./runtime");

const REPO_ROOT = path.resolve(__dirname, "../..");
const MANIFEST = /^project-([a-z0-9-]+)\.yaml$/;

function manifestSlugs(root = REPO_ROOT) {
  return fs.readdirSync(root).map(file => MANIFEST.exec(file)?.[1]).filter(Boolean).sort();
}

/**
 * Read a repository manifest using the SubQuery runtime's YAML parser.
 * @param {string} slug Manifest name without project- or .yaml.
 * @param {string} [root=REPO_ROOT] Directory containing the manifests.
 * @returns {{slug: string, manifest: object, chainId: string, endpoint: string, bundle: string|null}}
 * Public configuration, with an HTTP(S) endpoint and the compiled chain-types bundle name.
 * @throws {Error} If the manifest is unknown or lacks an endpoint or genesis hash.
 */
function readManifest(slug, root = REPO_ROOT) {
  if (!manifestSlugs(root).includes(slug)) throw new Error(`Unknown manifest: project-${slug}.yaml`);
  const manifest = createRuntimeRequire()("js-yaml").load(fs.readFileSync(path.join(root, `project-${slug}.yaml`), "utf8"));
  const endpoint = [manifest?.network?.endpoint].flat()[0];
  if (typeof endpoint !== "string" || !/^0x[\da-f]{64}$/i.test(manifest.network.chainId)) {
    throw new Error(`project-${slug}.yaml has no network endpoint or chainId`);
  }
  const file = manifest.network.chaintypes?.file;
  return { slug, manifest, chainId: manifest.network.chainId, endpoint: endpoint.trim().replace(/^ws/, "http"),
    bundle: file ? path.parse(file).name : null };
}

module.exports = { REPO_ROOT, manifestSlugs, readManifest };
