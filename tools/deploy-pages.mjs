/**
 * Deploy the static site to GitHub Pages without requiring git or gh.
 *
 * Usage (PowerShell):
 *   $env:GITHUB_TOKEN = "github_pat_..."
 *   $env:REPO_NAME = "bloom"   # optional
 *   node tools/deploy-pages.mjs
 *
 * The token is read from the environment and never printed.
 * The repository is public, as required for GitHub Pages on free accounts.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const REPO_NAME = process.env.REPO_NAME || 'bloom';
const OWNER = process.env.GITHUB_OWNER || '';
const BRANCH = process.env.BRANCH || 'main';
const API = 'https://api.github.com';

if (!TOKEN) {
  console.error('Missing GITHUB_TOKEN. Set a temporary token with repo/Pages permissions first.');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function github(path, options = {}) {
  const { allow404 = false, retries = 2, ...fetchOptions } = options;
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetch(`${API}${path}`, {
        ...fetchOptions,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${TOKEN}`,
          'User-Agent': 'bloom-pages-deploy',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(fetchOptions.headers || {}),
        },
      });
    } catch (error) {
      if (attempt < retries) {
        await sleep(1200 * (attempt + 1));
        continue;
      }
      throw error;
    }

    if (response.status === 404 && allow404) return null;

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (!response.ok) {
      if (response.status >= 500 && attempt < retries) {
        await sleep(1200 * (attempt + 1));
        continue;
      }
      const message = typeof data === 'object' && data
        ? `${data.message || response.status}${data.documentation_url ? ` (${data.documentation_url})` : ''}`
        : String(data || response.status);
      throw new Error(`GitHub API ${path} -> ${response.status}: ${message}`);
    }

    return data;
  }
}

async function collectFiles(directory, base = directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.deploy') continue;
    if (entry.name.startsWith('.chrome-')) continue;
    if (/\.log$/i.test(entry.name)) continue;

    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await collectFiles(absolute, base));
    } else if (entry.isFile()) {
      result.push({
        absolute,
        path: relative(base, absolute).split(sep).join('/'),
        size: (await stat(absolute)).size,
      });
    }
  }
  return result;
}

async function ensureRepository(owner) {
  let repo = await github(`/repos/${owner}/${REPO_NAME}`, { allow404: true });
  if (repo) {
    console.log(`Using existing repository ${owner}/${REPO_NAME}`);
    return repo;
  }

  console.log(`Creating public repository ${owner}/${REPO_NAME} ...`);
  repo = await github('/user/repos', {
    method: 'POST',
    body: JSON.stringify({
      name: REPO_NAME,
      description: '指尖生花 · 手势控制的 Three.js 粒子花园',
      private: false,
      has_issues: true,
      has_wiki: false,
      auto_init: false,
    }),
  });
  return repo;
}

async function waitForPages(owner) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const pages = await github(`/repos/${owner}/${REPO_NAME}/pages`, { allow404: true });
    if (pages?.html_url) {
      const build = await github(`/repos/${owner}/${REPO_NAME}/pages/builds/latest`, { allow404: true });
      if (!build || build.status === 'built') return { pages, build };
      if (build.status === 'errored') throw new Error(`Pages build failed: ${build.error?.message || 'unknown error'}`);
      console.log(`Pages: ${pages.status || 'building'} / build: ${build.status}`);
    } else {
      console.log('Pages: waiting for the site to be created ...');
    }
    await sleep(3000);
  }
  throw new Error('Timed out waiting for GitHub Pages to publish.');
}

async function main() {
  const user = OWNER ? { login: OWNER } : await github('/user');
  const owner = user.login;
  console.log(`Authenticated as ${owner}`);

  const repo = await ensureRepository(owner);
  if (repo.private) {
    throw new Error('GitHub Pages on free accounts requires a public repository. Make the repository public, then retry.');
  }

  const files = await collectFiles(ROOT);
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  console.log(`Uploading ${files.length} files (${(totalBytes / 1024 / 1024).toFixed(1)} MB) ...`);

  // The Git data API cannot create blobs in a repository that has never had a
  // commit. Seed an empty repository with a small README first.
  if (repo.size === 0) {
    const seed = Buffer.from('# 指尖生花\n\nGitHub Pages deployment.\n', 'utf8').toString('base64');
    await github(`/repos/${owner}/${REPO_NAME}/contents/README.md`, {
      method: 'PUT',
      body: JSON.stringify({
        message: 'Initialize GitHub Pages repository',
        content: seed,
        branch: repo.default_branch || BRANCH,
      }),
    });
    console.log('Initialized the empty repository with a seed commit.');
    await sleep(1500);
  }

  const tree = [];
  let completed = 0;
  for (const file of files) {
    const content = await readFile(file.absolute);
    const blob = await github(`/repos/${owner}/${REPO_NAME}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }),
    });
    tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
    completed += 1;
    if (completed % 10 === 0 || completed === files.length) {
      console.log(`  blobs ${completed}/${files.length}`);
    }
  }

  const defaultBranch = repo.default_branch || BRANCH;
  const ref = await github(`/repos/${owner}/${REPO_NAME}/git/ref/heads/${defaultBranch}`, { allow404: true });
  let baseTree;
  let parent;
  if (ref) {
    parent = ref.object.sha;
    const parentCommit = await github(`/repos/${owner}/${REPO_NAME}/git/commits/${parent}`);
    baseTree = parentCommit.tree.sha;
  }

  const treePayload = baseTree ? { base_tree: baseTree, tree } : { tree };
  const newTree = await github(`/repos/${owner}/${REPO_NAME}/git/trees`, {
    method: 'POST',
    body: JSON.stringify(treePayload),
  });

  const commit = await github(`/repos/${owner}/${REPO_NAME}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message: 'Deploy 指尖生花 to GitHub Pages',
      tree: newTree.sha,
      parents: parent ? [parent] : [],
    }),
  });

  if (ref) {
    await github(`/repos/${owner}/${REPO_NAME}/git/refs/heads/${defaultBranch}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: commit.sha, force: true }),
    });
  } else {
    await github(`/repos/${owner}/${REPO_NAME}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${defaultBranch}`, sha: commit.sha }),
    });
  }
  console.log(`Uploaded commit ${commit.sha.slice(0, 10)} to ${defaultBranch}`);

  // Give the new branch a moment to become visible to the Pages service.
  await sleep(1500);
  let pages = await github(`/repos/${owner}/${REPO_NAME}/pages`, { allow404: true });
  if (!pages) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        pages = await github(`/repos/${owner}/${REPO_NAME}/pages`, {
          method: 'POST',
          body: JSON.stringify({
            source: { branch: defaultBranch, path: '/' },
            build_type: 'legacy',
          }),
        });
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        console.log(`Pages setup retry ${attempt + 1}/5: ${error.message}`);
        await sleep(2500);
      }
    }
    console.log('Enabled GitHub Pages (legacy branch source)');
  } else {
    console.log('GitHub Pages already enabled; triggering a new build ...');
    await github(`/repos/${owner}/${REPO_NAME}/pages/builds`, { method: 'POST' }).catch(() => {});
  }

  const { pages: ready } = await waitForPages(owner);
  const siteUrl = ready.html_url || `https://${owner}.github.io/${REPO_NAME}/`;
  console.log('');
  console.log(`Published: ${siteUrl}`);
  console.log(`Repository: https://github.com/${owner}/${REPO_NAME}`);
  console.log('If the enabled site reports a build error, check the Pages settings in the repository.');
}

main().catch((error) => {
  console.error('');
  console.error(`Deployment failed: ${error.message}`);
  process.exitCode = 1;
});
