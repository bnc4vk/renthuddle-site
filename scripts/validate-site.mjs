import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const htmlFiles = walk(root).filter((file) => file.endsWith('.html'));
const errors = [];
const titles = new Map();
const descriptions = new Map();
const canonicals = new Map();

for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8');
  const title = one(html, /<title>([^<]+)<\/title>/i, file, 'title');
  const description = one(html, /<meta\s+name="description"\s+content="([^"]+)"/i, file, 'meta description');
  const canonical = one(html, /<link\s+rel="canonical"\s+href="([^"]+)"/i, file, 'canonical URL');
  recordUnique(titles, title, file, 'title');
  recordUnique(descriptions, description, file, 'meta description');
  recordUnique(canonicals, canonical, file, 'canonical URL');
  const h1Count = (html.match(/<h1(?:\s|>)/gi) || []).length;
  if (h1Count !== 1) errors.push(`${rel(file)} has ${h1Count} h1 elements (expected 1)`);
  validateLocalReferences(file, html);
  validateJsonLd(file, html);
}

const robots = readFileSync(join(root, 'robots.txt'), 'utf8');
for (const bot of ['OAI-SearchBot', 'Claude-SearchBot', 'Claude-User']) if (!robots.includes(`User-agent: ${bot}\nAllow: /`)) errors.push(`robots.txt does not explicitly allow ${bot}`);
if (/User-agent:\s*(GPTBot|ClaudeBot)/i.test(robots)) errors.push('robots.txt changes model-training crawler policy');

const sitemap = readFileSync(join(root, 'sitemap.xml'), 'utf8');
const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
if (sitemapUrls.length !== 5) errors.push(`sitemap.xml has ${sitemapUrls.length} URLs (expected 5)`);
for (const url of sitemapUrls) {
  const pathname = new URL(url).pathname.replace(/^\/renthuddle-site\/?/, '');
  const target = pathname ? join(root, pathname, 'index.html') : join(root, 'index.html');
  if (!existsSync(target)) errors.push(`Sitemap URL has no page: ${url}`);
}

const legacy = ['Dwe', 'lly Sheets Property Saver'].join('');
let legacyCount = 0;
for (const file of walk(root).filter((item) => /\.(?:html|xml|txt|md|json|css|mjs)$/.test(item))) legacyCount += readFileSync(file, 'utf8').split(legacy).length - 1;
if (legacyCount !== 2) errors.push(`Legacy-name reconciliation appears ${legacyCount} times (expected one note and one alternateName)`);

const homepage = readFileSync(join(root, 'index.html'), 'utf8');
for (const question of ['What is RentHuddle?', 'How can I compare rental listings with housemates?', 'Can I save Rightmove properties to Google Sheets?', 'Can I save Zillow rentals to a spreadsheet?', 'Does RentHuddle support Zoopla?', 'When does RentHuddle read a property page?', 'Where is my property data stored?', 'Can RentHuddle access all of my Google Drive files?', 'Does RentHuddle have a backend?', 'Is RentHuddle free?', 'Which browsers and property sites are supported?']) if (!homepage.includes(question)) errors.push(`Homepage FAQ is missing: ${question}`);
const homepageJsonLd = JSON.parse(homepage.match(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/i)?.[1] || '{}');
const graph = homepageJsonLd['@graph'] || [];
const application = graph.find((item) => item['@type'] === 'SoftwareApplication');
const organization = graph.find((item) => item['@type'] === 'Organization');
if (!organization || organization.name !== 'Brahe Labs') errors.push('JSON-LD Organization publisher is missing or incorrect');
if (!application || application.name !== 'RentHuddle' || application.softwareVersion !== '0.1.5') errors.push('JSON-LD SoftwareApplication identity or version is incorrect');
if (application?.alternateName !== legacy) errors.push('JSON-LD alternateName does not reconcile the previous product identity');
if (application?.downloadUrl !== 'https://chromewebstore.google.com/detail/renthuddle/emhefjlapefbhnameleoncmpjkcjbblk') errors.push('JSON-LD downloadUrl is incorrect');
if (application?.offers?.price !== '0') errors.push('JSON-LD free offer is missing');
if (!Array.isArray(application?.screenshot) || application.screenshot.length !== 5) errors.push('JSON-LD must include the five real store screenshots');

if (errors.length) { console.error(errors.map((error) => `- ${error}`).join('\n')); process.exit(1); }
console.log(`Site validation passed: ${htmlFiles.length} HTML pages, ${sitemapUrls.length} sitemap URLs, unique metadata, local links, JSON-LD and crawler rules.`);

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '.git' || entry.name === 'node_modules') return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  }).sort();
}

function one(html, pattern, file, label) {
  const matches = [...html.matchAll(new RegExp(pattern.source, `${pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`}`))];
  if (matches.length !== 1) { errors.push(`${rel(file)} has ${matches.length} ${label} values (expected 1)`); return ''; }
  return matches[0][1];
}

function recordUnique(map, value, file, label) {
  if (!value) return;
  if (map.has(value)) errors.push(`${label} is duplicated in ${rel(map.get(value))} and ${rel(file)}`);
  map.set(value, file);
}

function validateLocalReferences(file, html) {
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const value = match[1];
    if (!value.startsWith('/renthuddle-site/')) continue;
    const [pathname, hash] = value.slice('/renthuddle-site/'.length).split('#');
    let target = pathname ? join(root, pathname) : join(root, 'index.html');
    if (value.endsWith('/') || (!pathname && hash)) target = join(target === join(root, 'index.html') ? root : target, 'index.html');
    if (!existsSync(target)) errors.push(`${rel(file)} references missing ${value}`);
    if (hash && existsSync(target) && !readFileSync(target, 'utf8').includes(`id="${hash}"`)) errors.push(`${rel(file)} references missing fragment ${value}`);
  }
}

function validateJsonLd(file, html) {
  for (const match of html.matchAll(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
    try { JSON.parse(match[1]); } catch (error) { errors.push(`${rel(file)} has invalid JSON-LD: ${error.message}`); }
  }
}

function rel(file) { return relative(root, file) || '.'; }
