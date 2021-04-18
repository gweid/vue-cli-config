const fs = require('fs')
const path = require('path')
const debug = require('debug')
const merge = require('webpack-merge')
const Config = require('webpack-chain')
const PluginAPI = require('./PluginAPI')
const dotenv = require('dotenv')
const dotenvExpand = require('dotenv-expand')
const defaultsDeep = require('lodash.defaultsdeep')
const { chalk, warn, error, isPlugin, resolvePluginId, loadModule, resolvePkg } = require('@vue/cli-shared-utils')

const { defaults, validate } = require('./options')

module.exports = class Service {
  constructor (context, { plugins, pkg, inlineOptions, useBuiltIn } = {}) {
    process.VUE_CLI_SERVICE = this
    this.initialized = false
    this.context = context
    this.inlineOptions = inlineOptions
    this.webpackChainFns = []
    this.webpackRawConfigFns = []
    this.devServerConfigFns = []
    this.commands = {}
    // Folder containing the target package.json for plugins
    this.pkgContext = context
    // package.json containing the plugins
    this.pkg = this.resolvePkg(pkg)
    // If there are inline plugins, they will be used instead of those
    // found in package.json.
    // When useBuiltIn === false, built-in plugins are disabled. This is mostly
    // for testing.
    this.plugins = this.resolvePlugins(plugins, useBuiltIn)
    // pluginsToSkip will be populated during run()
    this.pluginsToSkip = new Set()
    // resolve the default mode to use for each command
    // this is provided by plugins as module.exports.defaultModes
    // so we can get the information without actually applying the plugin.
    this.modes = this.plugins.reduce((modes, { apply: { defaultModes }}) => {
      return Object.assign(modes, defaultModes)
    }, {})
  }

  resolvePkg (inlinePkg, context = this.context) {
    if (inlinePkg) {
      return inlinePkg
    }
    const pkg = resolvePkg(context)
    if (pkg.vuePlugins && pkg.vuePlugins.resolveFrom) {
      this.pkgContext = path.resolve(context, pkg.vuePlugins.resolveFrom)
      return this.resolvePkg(null, this.pkgContext)
    }
    return pkg
  }

  init (mode = process.env.VUE_CLI_MODE) {
    if (this.initialized) {
      return
    }
    this.initialized = true
    this.mode = mode

    // load mode .env
    if (mode) {
      this.loadEnv(mode)
    }
    // 加载环境相关
    this.loadEnv()

    // 加载用户配置，就是 vue.config.js
    const userOptions = this.loadUserOptions()

    // lodash 的 defaultsDeep 作用：defaultsDeep({ 'a': { 'b': 2 } }, { 'a': { 'b': 1, 'c': 3 } })
    // 结果就是 { 'a': { 'b': 2, 'c': 3 } }
    // 这里的 defaults() 执行的就过就是一些定义了一些 webpack 默认的配置
    // 所以这里实际上的作用就是，用户配置跟定义的一些基础默认配置合并
    this.projectOptions = defaultsDeep(userOptions, defaults())

    debug('vue:project-config')(this.projectOptions)

    // apply plugins.
    // 遍历 plugins
    this.plugins.forEach(({ id, apply }) => {
      if (this.pluginsToSkip.has(id)) return
      // 执行 plugins 上的 apply 方法
      apply(new PluginAPI(id, this), this.projectOptions)
    })

    // vue.config.js 中有 chainWebpack，可以通过 chainWebpack 进行链式操作
    // chainWebpack 的链式操作是基于 webpack-chain 这个库
    if (this.projectOptions.chainWebpack) {
      this.webpackChainFns.push(this.projectOptions.chainWebpack)
    }
    // vue.config.js 中有 configureWebpack
    // configureWebpack 对象将会被 webpack-merge 合并入最终的 webpack 配置
    if (this.projectOptions.configureWebpack) {
      this.webpackRawConfigFns.push(this.projectOptions.configureWebpack)
    }
  }

  loadEnv (mode) {
    const logger = debug('vue:env')
    const basePath = path.resolve(this.context, `.env${mode ? `.${mode}` : ``}`)
    const localPath = `${basePath}.local`

    const load = envPath => {
      try {
        const env = dotenv.config({ path: envPath, debug: process.env.DEBUG })
        dotenvExpand(env)
        logger(envPath, env)
      } catch (err) {
        // only ignore error if file is not found
        if (err.toString().indexOf('ENOENT') < 0) {
          error(err)
        }
      }
    }

    load(localPath)
    load(basePath)

    // by default, NODE_ENV and BABEL_ENV are set to "development" unless mode
    // is production or test. However the value in .env files will take higher
    // priority.
    if (mode) {
      // always set NODE_ENV during tests
      // as that is necessary for tests to not be affected by each other
      const shouldForceDefaultEnv = (
        process.env.VUE_CLI_TEST &&
        !process.env.VUE_CLI_TEST_TESTING_ENV
      )
      const defaultNodeEnv = (mode === 'production' || mode === 'test')
        ? mode
        : 'development'
      if (shouldForceDefaultEnv || process.env.NODE_ENV == null) {
        process.env.NODE_ENV = defaultNodeEnv
      }
      if (shouldForceDefaultEnv || process.env.BABEL_ENV == null) {
        process.env.BABEL_ENV = defaultNodeEnv
      }
    }
  }

  setPluginsToSkip (args) {
    const skipPlugins = args['skip-plugins']
    const pluginsToSkip = skipPlugins
      ? new Set(skipPlugins.split(',').map(id => resolvePluginId(id)))
      : new Set()

    this.pluginsToSkip = pluginsToSkip
  }

  resolvePlugins (inlinePlugins, useBuiltIn) {
    // 用于 builtInPlugins 数组遍历的 map 方法的回调
    const idToPlugin = id => ({
      id: id.replace(/^.\//, 'built-in:'), // built-in: commands/serve
      apply: require(id) // require('./commands/serve')
    })

    let plugins

    // 定义了一些内置的插件，里面都是一个个文件路径
    // 遍历这个数组，执行 map 方法
    const builtInPlugins = [
      // 这些是执行命令相关的
      './commands/serve',
      './commands/build',
      './commands/inspect',
      './commands/help',
      // config plugins are order sensitive
      // 这些是 webpack 基础配置相关的
      './config/base',
      './config/css',
      './config/prod',
      './config/app'
    ].map(idToPlugin)

    // 有没有使用一些其他的内置插件，比如 vue-router、vuex 等
    // 比如在需要使用 vuex 的时候，允许 vue add vuex 这样子为项目添加 vuex
    // 这是因为 vuex 开发的时候，可以作为 vue cli 插件使用
    // 我们也可以为 vue cli 脚手架开发插件，比如 element-plus 可以通过 vue add element-plus 引入
    // 最后，所有的插件都合并后保存在 plugins 里面
    if (inlinePlugins) {
      plugins = useBuiltIn !== false
        ? builtInPlugins.concat(inlinePlugins)
        : inlinePlugins
    } else {
      const projectPlugins = Object.keys(this.pkg.devDependencies || {})
        .concat(Object.keys(this.pkg.dependencies || {}))
        .filter(isPlugin)
        .map(id => {
          if (
            this.pkg.optionalDependencies &&
            id in this.pkg.optionalDependencies
          ) {
            let apply = () => {}
            try {
              apply = require(id)
            } catch (e) {
              warn(`Optional dependency ${id} is not installed.`)
            }

            return { id, apply }
          } else {
            return idToPlugin(id)
          }
        })
      plugins = builtInPlugins.concat(projectPlugins)
    }

    // Local plugins
    if (this.pkg.vuePlugins && this.pkg.vuePlugins.service) {
      const files = this.pkg.vuePlugins.service
      if (!Array.isArray(files)) {
        throw new Error(`Invalid type for option 'vuePlugins.service', expected 'array' but got ${typeof files}.`)
      }
      plugins = plugins.concat(files.map(file => ({
        id: `local:${file}`,
        apply: loadModule(`./${file}`, this.pkgContext)
      })))
    }

    // 将 plugins 返回
    return plugins
  }

  async run (name, args = {}, rawArgv = []) {
    // resolve mode
    // prioritize inline --mode
    // fallback to resolved default modes from plugins or development if --watch is defined
    // 根据参数确定是开发环境还是生产环境
    // name 就是 vue-cli-service serve/vue-cli-service build 中的 serve/build
    const mode = args.mode || (name === 'build' && args.watch ? 'development' : this.modes[name])

    // --skip-plugins arg may have plugins that should be skipped during init()
    this.setPluginsToSkip(args)

    // load env variables, load user config, apply plugins
    // 加载环境变量相关、用户配置、应用插件
    this.init(mode)

    args._ = args._ || []

    // 通过 this.commands[name] 获取到 command
    let command = this.commands[name]

    if (!command && name) {
      error(`command "${name}" does not exist.`)
      process.exit(1)
    }
    if (!command || args.help || args.h) {
      command = this.commands.help
    } else {
      args._.shift() // remove command itself
      rawArgv.shift()
    }

    // 拿到 command 的 fn 函数
    const { fn } = command
    // 执行 fn 函数，返回结果
    return fn(args, rawArgv)
  }

  resolveChainableWebpackConfig () {
    const chainableConfig = new Config()
    // apply chains
    this.webpackChainFns.forEach(fn => fn(chainableConfig))
    return chainableConfig
  }

  resolveWebpackConfig (chainableConfig = this.resolveChainableWebpackConfig()) {
    if (!this.initialized) {
      throw new Error('Service must call init() before calling resolveWebpackConfig().')
    }
    // get raw config
    let config = chainableConfig.toConfig()
    const original = config
    // apply raw config fns
    this.webpackRawConfigFns.forEach(fn => {
      if (typeof fn === 'function') {
        // function with optional return value
        const res = fn(config)
        if (res) config = merge(config, res)
      } else if (fn) {
        // merge literal values
        config = merge(config, fn)
      }
    })

    // #2206 If config is merged by merge-webpack, it discards the __ruleNames
    // information injected by webpack-chain. Restore the info so that
    // vue inspect works properly.
    if (config !== original) {
      cloneRuleNames(
        config.module && config.module.rules,
        original.module && original.module.rules
      )
    }

    // check if the user has manually mutated output.publicPath
    const target = process.env.VUE_CLI_BUILD_TARGET
    if (
      !process.env.VUE_CLI_TEST &&
      (target && target !== 'app') &&
      config.output.publicPath !== this.projectOptions.publicPath
    ) {
      throw new Error(
        `Do not modify webpack output.publicPath directly. ` +
        `Use the "publicPath" option in vue.config.js instead.`
      )
    }

    if (
      !process.env.VUE_CLI_ENTRY_FILES &&
      typeof config.entry !== 'function'
    ) {
      let entryFiles
      if (typeof config.entry === 'string') {
        entryFiles = [config.entry]
      } else if (Array.isArray(config.entry)) {
        entryFiles = config.entry
      } else {
        entryFiles = Object.values(config.entry || []).reduce((allEntries, curr) => {
          return allEntries.concat(curr)
        }, [])
      }

      entryFiles = entryFiles.map(file => path.resolve(this.context, file))
      process.env.VUE_CLI_ENTRY_FILES = JSON.stringify(entryFiles)
    }

    return config
  }

  // 加载用户配置 vue.config.js
  loadUserOptions () {
    // vue.config.c?js
    let fileConfig, pkgConfig, resolved, resolvedFrom
    const esm = this.pkg.type && this.pkg.type === 'module'

    const possibleConfigPaths = [
      process.env.VUE_CLI_SERVICE_CONFIG_PATH,
      './vue.config.js',
      './vue.config.cjs'
    ]

    let fileConfigPath
    for (const p of possibleConfigPaths) {
      const resolvedPath = p && path.resolve(this.context, p)
      if (resolvedPath && fs.existsSync(resolvedPath)) {
        fileConfigPath = resolvedPath
        break
      }
    }

    if (fileConfigPath) {
      if (esm && fileConfigPath === './vue.config.js') {
        throw new Error(`Please rename ${chalk.bold('vue.config.js')} to ${chalk.bold('vue.config.cjs')} when ECMAScript modules is enabled`)
      }

      try {
        fileConfig = loadModule(fileConfigPath, this.context)

        if (typeof fileConfig === 'function') {
          fileConfig = fileConfig()
        }

        if (!fileConfig || typeof fileConfig !== 'object') {
          // TODO: show throw an Error here, to be fixed in v5
          error(
            `Error loading ${chalk.bold(fileConfigPath)}: should export an object or a function that returns object.`
          )
          fileConfig = null
        }
      } catch (e) {
        error(`Error loading ${chalk.bold(fileConfigPath)}:`)
        throw e
      }
    }

    // package.vue
    pkgConfig = this.pkg.vue
    if (pkgConfig && typeof pkgConfig !== 'object') {
      error(
        `Error loading vue-cli config in ${chalk.bold(`package.json`)}: ` +
        `the "vue" field should be an object.`
      )
      pkgConfig = null
    }

    if (fileConfig) {
      if (pkgConfig) {
        warn(
          `"vue" field in package.json ignored ` +
          `due to presence of ${chalk.bold('vue.config.js')}.`
        )
        warn(
          `You should migrate it into ${chalk.bold('vue.config.js')} ` +
          `and remove it from package.json.`
        )
      }
      resolved = fileConfig
      resolvedFrom = 'vue.config.js'
    } else if (pkgConfig) {
      resolved = pkgConfig
      resolvedFrom = '"vue" field in package.json'
    } else {
      resolved = this.inlineOptions || {}
      resolvedFrom = 'inline options'
    }

    if (resolved.css && typeof resolved.css.modules !== 'undefined') {
      if (typeof resolved.css.requireModuleExtension !== 'undefined') {
        warn(
          `You have set both "css.modules" and "css.requireModuleExtension" in ${chalk.bold('vue.config.js')}, ` +
          `"css.modules" will be ignored in favor of "css.requireModuleExtension".`
        )
      } else {
        warn(
          `"css.modules" option in ${chalk.bold('vue.config.js')} ` +
          `is deprecated now, please use "css.requireModuleExtension" instead.`
        )
        resolved.css.requireModuleExtension = !resolved.css.modules
      }
    }

    // normalize some options
    ensureSlash(resolved, 'publicPath')
    if (typeof resolved.publicPath === 'string') {
      resolved.publicPath = resolved.publicPath.replace(/^\.\//, '')
    }
    removeSlash(resolved, 'outputDir')

    // validate options
    validate(resolved, msg => {
      error(
        `Invalid options in ${chalk.bold(resolvedFrom)}: ${msg}`
      )
    })

    return resolved
  }
}

function ensureSlash (config, key) {
  const val = config[key]
  if (typeof val === 'string') {
    config[key] = val.replace(/([^/])$/, '$1/')
  }
}

function removeSlash (config, key) {
  if (typeof config[key] === 'string') {
    config[key] = config[key].replace(/\/$/g, '')
  }
}

function cloneRuleNames (to, from) {
  if (!to || !from) {
    return
  }
  from.forEach((r, i) => {
    if (to[i]) {
      Object.defineProperty(to[i], '__ruleNames', {
        value: r.__ruleNames
      })
      cloneRuleNames(to[i].oneOf, r.oneOf)
    }
  })
}
