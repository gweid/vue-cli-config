# vue-cli 源码阅读

> 基于 vue-cli 4.5



## 准备工作

1. 将 vue-cli 源码下载下来
2. 利用 vue-cli 创建项目 `vue create vue-app`

基本目录结构：

```
vue-cli-config
├── vue-app     // vue create vue-app 创建的项目
└── vue-cli     // vue-cli 源码
```



## vue-cli 启动

在 vue 项目中，启动命令就是 npm run serve

```js
{
  "scripts": {
    "serve": "vue-cli-service serve",
    "build": "vue-cli-service build",
     "lint": "vue-cli-service lint"
  }
}
```

实际上就是执行 npx vue-cli-service serve 命令，会到 node_modules/bin 下面找到 vue-cli-service 文件：

```js
#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\,/,g')")

case `uname` in
    *CYGWIN*|*MINGW*|*MSYS*) basedir=`cygpath -w "$basedir"`;;
esac

if [ -x "$basedir/node" ]; then
  "$basedir/node"  "$basedir/../@vue/cli-service/bin/vue-cli-service.js" "$@"
  ret=$?
else 
  node  "$basedir/../@vue/cli-service/bin/vue-cli-service.js" "$@"
  ret=$?
fi
exit $ret
```

可以看出，实际上就是通过 shell 命令执行 `@vue/cli-service/bin/vue-cli-service.js`



`@vue/cli-service/bin/vue-cli-service.js`：

```js
const Service = require('../lib/Service')
const service = new Service(process.env.VUE_CLI_CONTEXT || process.cwd())

// 获取命令参数 "serve": "vue-cli-service serve"
const rawArgv = process.argv.slice(2)
const args = require('minimist')(rawArgv, {
  boolean: [
    // build
    'modern',
    'report',
    'report-json',
    'inline-vue',
    'watch',
    // serve
    'open',
    'copy',
    'https',
    // inspect
    'verbose'
  ]
})

// command 的值就是 "serve"
const command = args._[0]

service.run(command, args, rawArgv).catch(err => {
  error(err)
  process.exit(1)
})
```

引入 Service，然后 new Service 创建 service 实例，最后执行 service.run 方法



现在来看看 Service 这个类：

`@vue/cli-service/lib/Service.js`：

```js
module.exports = class Service {
    constructor (context, { plugins, pkg, inlineOptions, useBuiltIn } = {}) {
        // ...
        this.commands = {}
        
        this.plugins = this.resolvePlugins(plugins, useBuiltIn)
    }

    async run (name, args = {}, rawArgv = []) {
        // ...
 
        // 根据参数确定是开发环境还是生产环境
        // name 就是 vue-cli-service serve/vue-cli-service build 中的 serve/build
        const mode = args.mode || (name === 'build' && args.watch ? 'development' : this.modes[name])

        // 加载环境变量相关、用户配置、应用插件
        this.init(mode)

        // 通过 this.commands[name] 获取到 command
        let command = this.commands[name]

        // 拿到 command 的 fn 函数
        const { fn } = command
        // 执行 fn 函数，返回结果
        return fn(args, rawArgv)
  }
}
```

可以看到 service.run 中关键的步骤：

- 获取环境变量 mode 用于判别是开发环境还是生产环境
- this.init：加载环境变量相关、用户配置、应用插件
- command：通过 this.commands[name] 获取到
- fn 函数：拿到 command 的 fn 函数
- 执行 fn 函数，返回结果

这里有个很奇怪的一点，就是 command 通过  `this.commands[name]` 得到，name 就是 “serve”，也就是说 `command = this.commands['serve']`，但是，在 Service 类的 constructor 构造函数中，可以看到，`this.commands = {}` 是一个空对象，那么 `this.commands` 在什么时候赋值的呢？



回头看看 this.commands[name] 之前干了什么，执行了 this.init 方法，看看这个 init 方法：

```js
class Service {
    init (mode = process.env.VUE_CLI_MODE) {
        // ...

        // 加载环境相关
        this.loadEnv()

        // 加载用户配置，就是 vue.config.js
        const userOptions = this.loadUserOptions()
        
        // lodash 的 defaultsDeep 作用：defaultsDeep({ 'a': { 'b': 2 } }, { 'a': { 'b': 1, 'c': 3 } })
        // 结果就是 { 'a': { 'b': 2, 'c': 3 } }
        // 这里的 defaults() 执行的就过就是一些定义了一些 webpack 默认的配置，入口，出口等
        // 所以这里实际上的作用就是，用户配置跟定义的一些基础默认配置合并
        this.projectOptions = defaultsDeep(userOptions, defaults())
		
        // 遍历 vue cli 的 plugins
        this.plugins.forEach(({ id, apply }) => {
          if (this.pluginsToSkip.has(id)) return
          // 执行 plugins 上的 apply 方法
          apply(new PluginAPI(id, this), this.projectOptions)
        })

        // apply webpack configs from project config file
        if (this.projectOptions.chainWebpack) {
          this.webpackChainFns.push(this.projectOptions.chainWebpack)
        }
        if (this.projectOptions.configureWebpack) {
          this.webpackRawConfigFns.push(this.projectOptions.configureWebpack)
        }
  }
}
```

可以看到，this.init 做的事：

- 加载环境相关 env
- 加载用户配置，就是 vue.config.js
- 合并用户配置以及一些基础默认配置
- 遍历 vue cli 的 plugins，执行插件的 apply 方法
- ...

这里面最重要的异步就是：遍历 vue cli 的插件，执行插件的 apply 方法。看看 vue cli 插件是怎么来的：

```js
class Service {
    constructor() {
        this.plugins = this.resolvePlugins(plugins, useBuiltIn)
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
          './commands/serve',
          './commands/build',
          './commands/inspect',
          './commands/help',
          // config plugins are order sensitive
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
}
```

plugins 通过 resolvePlugins 函数生成，最终返回的类似：

```js
plugins = [
    {
        id: 'built-in: commands/serve',
        apply: require('./commands/serve')
    },
    {...},
    ...
]
```

所以上面的遍历 plugins，执行 apply 方法，对于 serve 来说，实际上就是执行 `require('./commands/serve')()`，引入 ./commands/serve 的方法，执行



来看看 `@vue\cli-service\lib\commands\serve.js` 这个文件：

```js
module.exports = (api, options) => {
    // 执行 api.registerCommand 注册 Command
     api.registerCommand(
        'serve',
        {
        description: 'start development server',
    	usage: 'vue-cli-service serve [options] [entry]',
        options: {...}
    	},
        async function serve (args) {...}
    )
}
```

可以看出，这个文件就是导出了一个函数，apply() 就是执行的这个导出的函数，回头看看：

```js
this.plugins.forEach(({ id, apply }) => {
    if (this.pluginsToSkip.has(id)) return
    // 执行 plugins 上的 apply 方法
    apply(new PluginAPI(id, this), this.projectOptions)
})
```

所以 api.registerCommand 实际上执行的就是 new PluginAPI(id, this) 上的 registerCommand 方法，这个 new PluginAPI(id, this) 传进去两个参数，一个是 id（built-in: commands/serve），一个是 this（当前 service）



来看看 PluginApi 这个类：

```js
class PluginAPI {
    constructor (id, service) {
      this.id = id
      this.service = service
    }
    
    registerCommand (name, opts, fn) {
      if (typeof opts === 'function') {
        fn = opts
        opts = null
      }
      this.service.commands[name] = { fn, opts: opts || {}}
    }
}
```

- 这里的 service 就是传过来的 Service 类
- registerCommand 注册 command，并将其方法 Service 类的 commands 上

到此，终于是知道了为什么可以 this.commands[name] 获取到 command，并且 command 里面有 fn 函数

![](/imgs/img1.png)



## vue cli 加载配置

