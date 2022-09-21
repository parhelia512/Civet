import assert from "assert"
import path from "path"

import BundledCivetModule from "@danielx/civet"
import type { SourceMap as CivetSourceMap } from "@danielx/civet"

import ts, {
  CompilerHost,
  CompilerOptions,
  IScriptSnapshot,
  LanguageServiceHost,
} from "typescript"

const {
  ScriptSnapshot,
  createCompilerHost,
  createLanguageService,
  parseJsonConfigFileContent,
  readConfigFile,
  sys,
} = ts

import { TextDocument } from "vscode-languageserver-textdocument"
import { fileURLToPath } from "url"
import { createRequire } from "module"
// TODO: project Coffee version?
import { compile as coffeeCompile } from "coffeescript"
import { convertCoffeeScriptSourceMap } from "./util.mjs"

// HACK to get __dirname working in tests with ts-node
// ts-node needs everything to be modules for .civet files to work
// and modules don't have __dirname
var dir : string
try {
  dir = __dirname
} catch (e) {
  //@ts-ignore
  dir = fileURLToPath(import.meta.url)
}

interface SourceMap {
  data: {
    lines: CivetSourceMap["data"]["lines"]
  }
}

// ts doesn't have this key in the type
interface ResolvedModuleWithFailedLookupLocations extends ts.ResolvedModuleWithFailedLookupLocations {
  failedLookupLocations: string[];
}

interface FileMeta {
  sourcemapLines: SourceMap["data"]["lines"] | undefined
  transpiledDoc: TextDocument | undefined
}

interface Host extends LanguageServiceHost {
  getMeta(path: string): FileMeta | undefined
  addOrUpdateDocument(doc: TextDocument): void
}

interface Transpiler {
  extension: string
  /**
   * The target extension of the transpiler (used to force module/commonjs via .mjs, .cjs, .mts, .cts, etc)
   * Must be a valid ts.Extension because those are the kinds that TypeScript understands.
   */
  target: ts.Extension
  compile(path: string, source: string): {
    code: string,
    sourceMap?: SourceMap
  } | undefined
}

interface Plugin {
  transpilers?: Transpiler[]
}

function TSHost(compilationSettings: CompilerOptions, initialFileNames: string[], baseHost: CompilerHost, transpilers: Map<string, Transpiler>): Host {
  const { rootDir } = compilationSettings
  assert(rootDir, "Most have root dir for now")

  const scriptFileNames: Set<string> = new Set(initialFileNames)
  const fileMetaData: Map<string, FileMeta> = new Map;

  const documents: Set<TextDocument> = new Set();
  const pathMap: Map<string, TextDocument> = new Map
  const snapshotMap: Map<string, IScriptSnapshot> = new Map

  let projectVersion = 0;

  const resolutionCache: ts.ModuleResolutionCache = ts.createModuleResolutionCache(rootDir, (fileName) => fileName, compilationSettings);

  let self: Host;

  return self = Object.assign({}, baseHost, {
    getDefaultLibFileName(options: ts.CompilerOptions) {
      const result = path.join(dir, "lib", ts.getDefaultLibFileName(options))
      console.log("getDefaultLibFileName", result)
      return result
    },
    getModuleResolutionCache() {
      return resolutionCache
    },
    /**
     * This is how TypeScript resolves module names when it finds things like `import { foo } from "bar"`.
     * We need to modify this to make sure that TypeScript can resolve our `.civet` files.
     * We default to the original behavior, but if it is a `.civet` file, we resolve it with the `.civet` extension.
     * This requires the `allowNonTsExtensions` option and `allowJs` options to be set to true.
     * Then TypeScript will call `getScriptSnapshot` with the `.civet` extension and we can do the transpilation there.
     */
    resolveModuleNames(moduleNames: string[], containingFile: string, _reusedNames: string[] | undefined, _redirectedReference: ts.ResolvedProjectReference | undefined, compilerOptions: CompilerOptions, _containingSourceFile?: ts.SourceFile) {
      return moduleNames.map(name => {
        let resolution
        // Try to resolve the module using the standard TypeScript logic
        resolution = ts.resolveModuleName(name, containingFile, compilerOptions, self, resolutionCache) as ResolvedModuleWithFailedLookupLocations

        let { resolvedModule } = resolution
        if (resolvedModule) {
          return resolvedModule
        }

        // get the transpiler for the extension
        const extension = getExtensionFromPath(name)
        const transpiler = transpilers.get(extension)
        if (transpiler) {
          const { target } = transpiler
          const resolved = path.resolve(path.dirname(containingFile), name)
          if (sys.fileExists(resolved)) {
            // TODO: add to resolution cache?
            resolvedModule = {
              resolvedFileName: resolved + target,
              extension: target,
              isExternalLibraryImport: false,
            }
            return resolvedModule
          }
        }

        return undefined
      });
    },
    /**
     * Add a VSCode TextDocument source file.
     * The VSCode document should keep track of its contents and version.
     * This accepts both `.civet` and `.ts` adding the transpiled targets to `scriptFileNames`.
     */
    addOrUpdateDocument(doc: TextDocument): void {
      const path = fileURLToPath(doc.uri)

      // Something may have changed so notify TS by updating the project version
      // Still not too sure exactly how TS uses this. Read `sychronizeHostData` in `typescript/src/sercivces/services.ts` for more info.
      projectVersion++

      const extension = getExtensionFromPath(path)
      const transpiler = transpilers.get(extension)

      if (transpiler) {
        const { target } = transpiler
        const transpiledPath = path + target

        let transpiledDoc = pathMap.get(transpiledPath)

        if (!transpiledDoc) {
          initTranspiledDoc(transpiledPath)

          // Add source doc
          documents.add(doc)
          pathMap.set(path, doc)
        }

        // Deleting the snapshot will force a new one to be created when requested
        snapshotMap.delete(transpiledPath)

        return
      }

      // Plain non-transpiled document
      if (!scriptFileNames.has(path)) {
        documents.add(doc)
        scriptFileNames.add(path)
        pathMap.set(path, doc)
      }

      // Clear the cached snapshot for this document
      snapshotMap.delete(path)
      return
    },
    getMeta(path: string) {
      const transpiledPath = getTranspiledPath(path)
      // This ensures that the transpiled meta data is created
      getOrCreatePathSnapshot(transpiledPath)

      return fileMetaData.get(path)
    },
    getProjectVersion() {
      return projectVersion.toString();
    },
    getCompilationSettings() {
      return compilationSettings;
    },
    // TODO: Handle source documents and document updates
    getScriptSnapshot(path: string) {
      const snap = getOrCreatePathSnapshot(path)
      // console.log("getScriptSnapshot", path, snap)
      return snap
    },
    getScriptVersion(path: string) {
      const version = pathMap.get(path)?.version.toString() || "0"
      // console.log("getScriptVersion", path, version)
      return version
    },
    getScriptFileNames() {
      return Array.from(scriptFileNames)
    },
    writeFile(fileName: string, content: string) {
      console.log("write", fileName, content)
    }
  });

  /**
   * Get the source code for a path.
   * Use the VSCode document if it exists otherwise use the file system.
   */
  function getPathSource(path: string): string {
    // Open VSCode docs and transpiled files should all be in the pathMap
    const doc = pathMap.get(path)
    if (doc) {
      return doc.getText()
    }

    if (sys.fileExists(path)) {
      return sys.readFile(path)!
    }

    return ""
  }

  function getTranspiledPath(path: string) {
    const extension = getExtensionFromPath(path)
    const transpiler = transpilers.get(extension)

    if (transpiler) {
      return path + transpiler.target
    }
    return path
  }

  function getOrCreatePathSnapshot(path: string) {
    let snapshot = snapshotMap.get(path)
    if (snapshot) return snapshot

    let transpiler

    // path comes in as transformed (transpiler target extension added), check for 2nd to last extension for transpiler
    // ie .coffee.js or .civet.ts or .hera.cjs

    const exts = getTranspiledExtensionsFromPath(path)
    if (exts && (transpiler = transpilers.get(exts[0]))) {
      // this is a possibly transpiled file

      const sourcePath = removeExtension(path)
      const sourceDoc = pathMap.get(sourcePath)
      let transpiledDoc = pathMap.get(path)
      if (!transpiledDoc) {
        transpiledDoc = initTranspiledDoc(path)
      }

      let source, sourceDocVersion = 0
      if (!sourceDoc) {
        // A source file from the file system
        source = sys.readFile(sourcePath)
      } else {
        source = sourceDoc.getText()
        sourceDocVersion = sourceDoc.version
      }

      // The source document is ahead of the transpiled document
      if (source && sourceDocVersion > transpiledDoc.version) {
        const transpiledCode = doTranspileAndUpdateMeta(transpiledDoc, sourceDocVersion, transpiler, sourcePath, source)
        snapshot = ScriptSnapshot.fromString(transpiledCode)
      }

      if (!snapshot) {
        // Use the old version if there was an error
        snapshot = ScriptSnapshot.fromString(transpiledDoc.getText())
      }

      snapshotMap.set(path, snapshot)
      return snapshot
    }

    // Regular non-transpiled file
    snapshot = ScriptSnapshot.fromString(getPathSource(path))
    snapshotMap.set(path, snapshot)
    return snapshot
  }

  function createOrUpdateMeta(path: string, transpiledDoc: TextDocument, sourcemapLines?: SourceMap["data"]["lines"]) {
    let meta = fileMetaData.get(path)

    if (!meta) {
      meta = {
        sourcemapLines,
        transpiledDoc,
      }

      fileMetaData.set(path, meta)
    } else {
      meta.sourcemapLines = sourcemapLines
    }
  }

  function doTranspileAndUpdateMeta(transpiledDoc: TextDocument, version: number, transpiler: Transpiler, sourcePath: string, sourceCode: string): string {
    // Definitely do not want to throw errors here, it can make TypeScript very unhappy if it can't get a snapshot/version
    try {
      var result = transpiler.compile(sourcePath, sourceCode)
    } catch (e) {
      // TODO: add error to diagnostics
      console.error(e)
    }

    if (result) {
      const { code: transpiledCode, sourceMap } = result
      createOrUpdateMeta(sourcePath, transpiledDoc, sourceMap?.data.lines)
      TextDocument.update(transpiledDoc, [{ text: transpiledCode }], version)

      return transpiledCode
    }
    return ""
  }

  function initTranspiledDoc(path: string) {
    // Create an empty document, it will be updated on-demand when `getScriptSnapshot` is called
    // `path` must be the in the format that TypeScript Language Service expects
    const transpiledDoc = TextDocument.create(path, "none", -1, "")
    // Add transpiled doc
    documents.add(transpiledDoc)
    pathMap.set(path, transpiledDoc)
    // Transpiled doc gets added to scriptFileNames
    scriptFileNames.add(path)

    return transpiledDoc
  }
}

function TSService(projectURL = "./") {
  const logger = console
  const projectPath = fileURLToPath(projectURL)
  const tsConfigPath = `${projectPath}tsconfig.json`
  const { config } = readConfigFile(tsConfigPath, sys.readFile)

  const existingOptions = {
    rootDir: projectPath,
    // This is necessary to load .civet files
    allowNonTsExtensions: true,
    // Better described as "allow non-ts, non-json extensions"
    allowJs: true,
  }

  const parsedConfig = parseJsonConfigFileContent(
    config,
    sys,
    projectPath,
    existingOptions,
    tsConfigPath,
    undefined,
  )
  logger.info("PARSED CONFIG\n", parsedConfig, "\n\n")

  //@ts-ignore
  const baseHost = createCompilerHost(parsedConfig)

  const transpilerDefinitions = [{
    extension: ".civet" as const,
    target: ".ts" as ts.Extension,
    compile: transpileCivet,
  }, {
    extension: ".coffee",
    target: ".js" as ts.Extension,
    compile: transpileCoffee,
  }].map<[string, Transpiler]>(def => [def.extension, def])

  const transpilers = new Map<string, Transpiler>(transpilerDefinitions)
  // TODO: May want to add transpiled files to fileNames
  const host = TSHost(parsedConfig.options, parsedConfig.fileNames, baseHost, transpilers)
  const service = createLanguageService(host)

  const projectRequire = createRequire(projectURL)

  // Use Civet from the project if present
  let Civet: typeof BundledCivetModule
  try {
    const civetPath = "@danielx/civet"
    Civet = projectRequire(civetPath)

    console.info(`LOADED PROJECT CIVET: ${path.join(projectURL, civetPath)} \n\n`)
  } catch (e) {
    console.info("USING BUNDLED CIVET")
    Civet = BundledCivetModule
  }

  return Object.assign({}, service, {
    host,
    getSourceFileName(fileName: string) {
      return remapFileName(fileName, transpilers)
    },
    loadPlugins: async function () {
      const civetFolder = path.join(projectPath, "./.civet/")
      // List files in civet folder
      const civetFiles = sys.readDirectory(civetFolder)

      // One day it would be nice to load plugins that could be transpiled but that is a whole can of worms.
      // VSCode Node verions, esm loaders, etc.
      const pluginFiles = civetFiles.filter(file => file.endsWith("plugin.mjs"))

      for (const filePath of pluginFiles) {
        console.info("Loading plugin", filePath)
        await loadPlugin(filePath)
      }
    }
  })

  async function loadPlugin(path: string) {
    await import(path)
      .then(({ default: plugin }: { default: Plugin }) => {
        console.info("Loaded plugin", plugin)
        plugin.transpilers?.forEach((transpiler: Transpiler) => {
          transpilers.set(transpiler.extension, transpiler)
        })
      })
      .catch(e => {
        console.error("Error loading plugin", path, e)
      })
  }

  function transpileCivet(path: string, source: string) {
    try {
      return Civet.compile(source, {
        filename: path,
        sourceMap: true
      })
    } catch (e) {
      console.error(e)
      return
    }
  }
}

function transpileCoffee(path: string, source: string) {
  const { js, sourceMap } = coffeeCompile(source, {
    bare: true,
    filename: path,
    header: false,
    sourceMap: true
  })

  const convertedSourceMap = convertCoffeeScriptSourceMap(sourceMap)

  console.log("COFFEE SOURCE MAP", sourceMap, convertedSourceMap)

  return {
    code: js,
    sourceMap: {
      data: {
        lines: convertedSourceMap
      }
    }
  }
}

/**
 * Returns the extension of the file including the dot.
 * @example
 * getExtension('foo/bar/baz.js') // => '.js'
 * @example
 * getExtension('foo/bar/baz') // => ''
 * @example
 * getExtension('foo/bar/baz.') // => ''
 */
function getExtensionFromPath(path: string): string {
  const match = path.match(lastExtension)
  if (!match) return ""
  return match[0]
}

// Regex to match last extension including dot
const lastExtension = /(?:\.(?:[^.]+))?$/
const lastTwoExtensions = /(\.[^.\/]*)(\.[^./]*)$/

/**
 * Returns the last two extensions of a path.
 *
 * @example
 * getLastTwoExtensions('foo/bar/baz.js') // => undefined
 * @example
 * getLastTwoExtensions('foo/bar/baz') // => undefined
 * @example
 * getLastTwoExtensions('foo/bar/baz.civet.ts') // => ['.civet', '.ts']
 */
function getTranspiledExtensionsFromPath(path: string): [string, string] | undefined {
  const match = path.match(lastTwoExtensions)
  if (!match) return

  return [match[1], match[2]]
}

/**
 * Removes the last extension from a path.
 * @example
 * removeExtension('foo/bar/baz.js') // => 'foo/bar/baz'
 * @example
 * removeExtension('foo/bar/baz') // => 'foo/bar/baz'
 * @example
 * removeExtension('foo/bar/baz.') // => 'foo/bar/baz.'
 * @example
 * removeExtension('foo/bar/baz.civet.ts') // => 'foo/bar/baz.civet'
 * @example
 * removeExtension('foo/bar.js/baz') // => 'foo/bar.js/baz'
 */
function removeExtension(path: string) {
  return path.replace(/\.[^\/.]+$/, "")
}

function remapFileName(fileName: string, transpilers: Map<string, Transpiler>): string {
  const [extension, target] = getTranspiledExtensionsFromPath(fileName) || []

  if (!extension) return fileName
  const transpiler = transpilers.get(extension)
  if (!transpiler) return fileName

  if (transpiler.target === target) {
    return removeExtension(fileName)
  }

  return fileName
}

export default TSService
