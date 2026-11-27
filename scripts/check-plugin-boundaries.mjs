#!/usr/bin/env node
// Keeps built-in plugins separable from the core (docs/PLUGIN_ARCHITECTURE.md):
// - the core reaches `plugins/` only through apps/server/src/plugins/registry.ts;
// - packages/plugin-api depends on nothing but `@contracts`, Node built-ins and package.json dependencies (its kit runs in the core and in plugins alike);
// - a server-side plugin file imports only the API, `@contracts`, Node built-ins, npm
//   dependencies, and files of its own package directory (`plugins/<vendor>/<name>/`), not those of another
//   package of the same vendor; a directory that exports several plugins (`acme/model-sources`) is one
//   package, so a build can leave a package out;
// - an installable package under `official/<name>/` follows the same rule for its own directory (the public reference plugins, published on the plugin source, not shipped inside the app);
// - a client file (`plugins/<vendor>/<name>/web/**`) imports only `@riffet/plugin-web`,
//   `@contracts`, npm dependencies and files of its own package, and nothing of Node or the server;
// - the web core reaches the client entries (`plugins/web.ts`) only through
//   apps/web/src/plugins/registry.ts, as the server core does through registry.ts;
// - the Mac app's canvas bundle (apps/macos/scripts/canvas-layout/) builds the canvas package's own
//   client layout into the app, so it may import that package's web files and nothing else of plugins/;
// - plugin-contributed agent backends must not be hardcoded in core `doctor.ts#BACKENDS`;
// - `AgentTraits` in plugin-api stays in sync with `NativeBackendTraits` (modulo `CORE_ONLY_TRAITS`);
// - `BackendCatalog.driverCapabilities` must not unconditionally overwrite boolean capabilities after `...capabilities`.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = 'apps/server/src/plugins/registry.ts';
const WEB_GATE = 'apps/web/src/plugins/registry.ts';
const WEB_ENTRIES = /^plugins\/web(?:\.[jt]sx?)?$/;
const MAC_CANVAS = 'apps/macos/scripts/canvas-layout/';
const CANVAS_CLIENT = 'plugins/riffet/canvas/web/';
// Client code of a package; `plugins/web.ts` lists them all, as `index.ts` does the server side.
const CLIENT_FILE = /^plugins\/[^/]+\/[^/]+\/web\//;
const API = 'packages/plugin-api/';
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const packages = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})]);
const builtins = new Set(builtinModules);

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'apps', 'packages', 'plugins', 'official'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter(file => /\.(?:[cm]?[jt]s|tsx)$/.test(file) && !file.startsWith('apps/mobile/') && !/(?:^|\/)(?:node_modules|dist|build)\//.test(file));

const posix = path => path.split(sep).join('/');
const packageName = specifier => specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
// A package that ships no types is declared by its `@types/` counterpart (`mdast` by `@types/mdast`, `@a/b` by `@types/a__b`).
const declared = specifier => {
  const name = packageName(specifier);
  return packages.has(name) || packages.has(`@types/${name.startsWith('@') ? name.slice(1).replace('/', '__') : name}`);
};
const problems = [];

for (const file of files) {
  let text;
  try { text = readFileSync(resolve(root, file), 'utf8'); } catch { continue; }
  for (const { fileName: specifier } of ts.preProcessFile(text, true, true).importedFiles) {
    const relativeTarget = specifier.startsWith('.') ? posix(relative(root, resolve(root, dirname(file), specifier))) : undefined;
    const fail = reason => problems.push(`${file}: ${reason} (${specifier})`);
    if (CLIENT_FILE.test(file) || file === 'plugins/web.ts') {
      if (relativeTarget !== undefined) {
        const own = file === 'plugins/web.ts' ? 'plugins/' : `${file.split('/').slice(0, 3).join('/')}/`;
        if (!relativeTarget.startsWith(own)) fail(`may only import files under ${own}`);
      } else if (specifier !== '@riffet/plugin-web' && specifier !== '@contracts' && specifier !== '@riffet/contracts' && !declared(specifier)) {
        fail('client code may import only @riffet/plugin-web, @contracts and package.json dependencies');
      }
    } else if (file.startsWith('plugins/') || file.startsWith('official/')) {
      if (relativeTarget !== undefined) {
        // `plugins/index.ts` and `web.ts` list the packages; every other file belongs to the one directory `plugins/<vendor>/<name>/`.
        const own = file.startsWith('official/') ? `${file.split('/').slice(0, 2).join('/')}/` : file.split('/').length > 2 ? `${file.split('/').slice(0, 3).join('/')}/` : 'plugins/';
        if (!relativeTarget.startsWith(own)) fail(`may only import files under ${own}`);
      } else if (specifier !== '@riffet/plugin-api' && !specifier.startsWith('@riffet/plugin-api/') && specifier !== '@contracts' && specifier !== '@riffet/contracts' && !specifier.startsWith('node:') && !builtins.has(specifier) && !declared(specifier)) {
        fail('may import only @riffet/plugin-api, @contracts, Node built-ins and package.json dependencies');
      }
    } else if (file.startsWith(API)) {
      if (relativeTarget !== undefined ? !relativeTarget.startsWith(API)
        : specifier !== '@contracts' && specifier !== '@riffet/contracts' && !specifier.startsWith('node:') && !builtins.has(specifier) && !declared(specifier)) fail('the plugin API may import only @contracts, Node built-ins and package.json dependencies');
    } else if ((relativeTarget === 'plugins' || relativeTarget?.startsWith('plugins/')) && file !== GATE && !(file === WEB_GATE && WEB_ENTRIES.test(relativeTarget))
      && !(file.startsWith(MAC_CANVAS) && relativeTarget.startsWith(CANVAS_CLIENT))) {
      fail(`only ${GATE} may import plugins/, and ${WEB_GATE} only plugins/web`);
    }
  }
}

const DOCTOR_FILE = 'apps/server/src/doctor.ts';
const BACKEND_TYPES_FILE = 'apps/server/src/backends/types.ts';
const PLUGIN_AGENT_FILE = 'packages/plugin-api/src/agent.ts';
const CATALOG_FILE = 'apps/server/src/backends/catalog.ts';
const PLUGIN_ENTRY = /^(?:plugins\/riffet|official)\/[^/]+\/index\.ts$/;

// Traits used only by core built-in drivers and intentionally not exposed on the plugin AgentTraits API yet.
const CORE_ONLY_TRAITS = new Set(['extensionToggles']);
/**
 * Traits the core no longer reads but `AgentTraits` keeps, marked `@deprecated`, so plugins built against a released
 * API still compile (docs/TURN-LIFECYCLE.md §4.3).
 */
const RETIRED_PLUGIN_TRAITS = new Set(['reportsTurnOutcome', 'completesOnTurnEvent']);

const PROTECTED_CAPABILITY_FLAGS = new Set([
  'supportsTargetedStop',
  'supportsInterrupt',
  'supportsSteer',
  'supportsResume',
  'supportsHistory',
  'supportsModelSelection',
  'supportsModeSelection',
  'supportsPermissionSelection',
  'supportsTerminal',
  'requiresLiveTerminal',
  'supportsPrewarm',
  'supportsInitialPromptArgs',
  'supportsSessionReferences',
  'inlineSkills',
]);

function parseSourceFile(relPath) {
  const fullPath = resolve(root, relPath);
  if (!existsSync(fullPath)) return undefined;
  return ts.createSourceFile(relPath, readFileSync(fullPath, 'utf8'), ts.ScriptTarget.Latest, true);
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyKeyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function stringLiteralValue(node) {
  const unwrapped = unwrapExpression(node);
  return ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped) ? unwrapped.text : undefined;
}

function findObjectProperty(objectLiteral, key) {
  for (const prop of objectLiteral.properties) {
    if (ts.isPropertyAssignment(prop) && propertyKeyName(prop.name) === key) return prop;
  }
  return undefined;
}

function collectPluginAgentBackendIds() {
  const ids = new Set();
  for (const file of files) {
    if (!PLUGIN_ENTRY.test(file)) continue;
    const sourceFile = parseSourceFile(file);
    if (!sourceFile) continue;
    const visit = node => {
      if (ts.isPropertyAssignment(node) && propertyKeyName(node.name) === 'contributes') {
        const contributesObj = unwrapExpression(node.initializer);
        if (ts.isObjectLiteralExpression(contributesObj)) {
          const backendsProp = findObjectProperty(contributesObj, 'agentBackends');
          const backendsArray = backendsProp ? unwrapExpression(backendsProp.initializer) : undefined;
          if (backendsArray && ts.isArrayLiteralExpression(backendsArray)) {
            for (const element of backendsArray.elements) {
              const item = unwrapExpression(element);
              if (!ts.isObjectLiteralExpression(item)) continue;
              const idProp = findObjectProperty(item, 'id');
              const id = idProp ? stringLiteralValue(idProp.initializer) : undefined;
              if (id) ids.add(id);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    // Official plugins may declare their manifest in a sibling `riffet-plugin.json`.
    if (file.startsWith('official/')) {
      const jsonPath = resolve(root, dirname(file), 'riffet-plugin.json');
      if (existsSync(jsonPath)) {
        try {
          const manifestJson = JSON.parse(readFileSync(jsonPath, 'utf8'));
          for (const entry of manifestJson?.contributes?.agentBackends ?? []) {
            if (typeof entry?.id === 'string' && entry.id) ids.add(entry.id);
          }
        } catch { /* ignore malformed non-manifest json */ }
      }
    }
  }
  return ids;
}

function extractDoctorBackendKeys() {
  const sourceFile = parseSourceFile(DOCTOR_FILE);
  if (!sourceFile) return undefined;
  let keys;
  const visit = node => {
    if (keys) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'BACKENDS' && node.initializer) {
      const obj = unwrapExpression(node.initializer);
      if (ts.isObjectLiteralExpression(obj)) {
        keys = new Set();
        for (const prop of obj.properties) {
          if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop) || ts.isMethodDeclaration(prop)) {
            const key = propertyKeyName(prop.name);
            if (key) keys.add(key);
          }
        }
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return keys;
}

function extractExportedInterfaceProperties(relPath, interfaceName) {
  const sourceFile = parseSourceFile(relPath);
  if (!sourceFile) return undefined;
  for (const stmt of sourceFile.statements) {
    if (
      ts.isInterfaceDeclaration(stmt)
      && stmt.name.text === interfaceName
      && stmt.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      const props = new Set();
      for (const member of stmt.members) {
        if (ts.isPropertySignature(member) || ts.isMethodSignature(member)) {
          const key = propertyKeyName(member.name);
          if (key) props.add(key);
        }
      }
      return props;
    }
  }
  return undefined;
}

function checkDoctorCoreBackends() {
  const pluginBackendIds = collectPluginAgentBackendIds();
  if (!pluginBackendIds.size) {
    problems.push('scripts/check-plugin-boundaries.mjs: failed to discover any plugin-contributed agentBackends in plugins/riffet/*/index.ts or official/*/index.ts');
  }
  const doctorBackendKeys = extractDoctorBackendKeys();
  if (!doctorBackendKeys) {
    problems.push(`${DOCTOR_FILE}: could not locate BACKENDS object literal`);
    return pluginBackendIds;
  }
  for (const id of pluginBackendIds) {
    if (doctorBackendKeys.has(id)) {
      problems.push(`${DOCTOR_FILE}: plugin agent backend "${id}" must contribute doctorChecks from its plugin instead of hardcoding in core BACKENDS`);
    }
  }
  return pluginBackendIds;
}

function checkAgentTraitsSync() {
  const nativeTraits = extractExportedInterfaceProperties(BACKEND_TYPES_FILE, 'NativeBackendTraits');
  const agentTraits = extractExportedInterfaceProperties(PLUGIN_AGENT_FILE, 'AgentTraits');
  if (!nativeTraits?.size) {
    problems.push(`${BACKEND_TYPES_FILE}: could not locate exported interface NativeBackendTraits`);
    return undefined;
  }
  if (!agentTraits?.size) {
    problems.push(`${PLUGIN_AGENT_FILE}: could not locate exported interface AgentTraits`);
    return undefined;
  }
  for (const name of nativeTraits) {
    if (!agentTraits.has(name) && !CORE_ONLY_TRAITS.has(name)) {
      problems.push(`${PLUGIN_AGENT_FILE}: AgentTraits is missing trait "${name}" declared in NativeBackendTraits (add to AgentTraits or document in CORE_ONLY_TRAITS)`);
    }
  }
  for (const name of agentTraits) {
    if (!nativeTraits.has(name) && !RETIRED_PLUGIN_TRAITS.has(name)) {
      problems.push(`${PLUGIN_AGENT_FILE}: AgentTraits declares "${name}" which does not exist on NativeBackendTraits`);
    }
  }
  for (const name of RETIRED_PLUGIN_TRAITS) {
    if (nativeTraits.has(name)) problems.push(`scripts/check-plugin-boundaries.mjs: RETIRED_PLUGIN_TRAITS entry "${name}" is back on NativeBackendTraits — remove it from the list`);
  }
  for (const name of CORE_ONLY_TRAITS) {
    if (agentTraits.has(name)) {
      problems.push(`scripts/check-plugin-boundaries.mjs: CORE_ONLY_TRAITS entry "${name}" is already declared on AgentTraits — remove stale exemption`);
    } else if (!nativeTraits.has(name)) {
      problems.push(`scripts/check-plugin-boundaries.mjs: CORE_ONLY_TRAITS entry "${name}" no longer exists on NativeBackendTraits — remove stale exemption`);
    }
  }
  return agentTraits;
}

function checkDriverCapabilitiesOverrides() {
  const sourceFile = parseSourceFile(CATALOG_FILE);
  if (!sourceFile) {
    problems.push(`${CATALOG_FILE}: file not found`);
    return;
  }
  let methodNode;
  const findMethod = node => {
    if (methodNode) return;
    if (ts.isClassDeclaration(node) && node.name?.text === 'BackendCatalog') {
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && propertyKeyName(member.name) === 'driverCapabilities') {
          methodNode = member;
          return;
        }
      }
    }
    ts.forEachChild(node, findMethod);
  };
  findMethod(sourceFile);
  if (!methodNode?.body) {
    problems.push(`${CATALOG_FILE}: could not locate BackendCatalog.driverCapabilities method`);
    return;
  }

  let checkedReturnObjects = 0;
  const visitBody = node => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) {
      const expr = unwrapExpression(node.expression);
      if (ts.isObjectLiteralExpression(expr)) {
        const spreadIndex = expr.properties.findIndex(prop => {
          if (!ts.isSpreadAssignment(prop)) return false;
          const target = unwrapExpression(prop.expression);
          return ts.isIdentifier(target) && target.text === 'capabilities';
        });
        if (spreadIndex >= 0) {
          checkedReturnObjects += 1;
          for (const prop of expr.properties.slice(spreadIndex + 1)) {
            if (!ts.isPropertyAssignment(prop)) continue;
            const key = propertyKeyName(prop.name);
            if (!key || !PROTECTED_CAPABILITY_FLAGS.has(key)) continue;
            const value = unwrapExpression(prop.initializer);
            if (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword) {
              const literal = value.kind === ts.SyntaxKind.TrueKeyword ? 'true' : 'false';
              problems.push(`${CATALOG_FILE}: BackendCatalog.driverCapabilities must not unconditionally overwrite "${key}" with literal ${literal} after ...capabilities (use capabilities.${key} ?? ... or a conditional spread)`);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visitBody);
  };
  ts.forEachChild(methodNode.body, visitBody);

  if (checkedReturnObjects === 0) {
    problems.push(`${CATALOG_FILE}: could not locate return object literal with ...capabilities in BackendCatalog.driverCapabilities`);
  }
}

const pluginBackendIds = checkDoctorCoreBackends();
const agentTraits = checkAgentTraitsSync();
checkDriverCapabilitiesOverrides();

if (problems.length) {
  console.error(`Plugin boundary violations:\n${problems.map(problem => `  ${problem}`).join('\n')}`);
  process.exit(1);
}
console.log(`Plugin boundaries hold (${files.length} files, ${pluginBackendIds.size} plugin agent backends, ${agentTraits?.size ?? 0} agent traits).`);
