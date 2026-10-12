import { builtinEnvironments } from 'vitest/runtime'

// The custom Vue renderer needs client render functions, not SSR output.
export default {
  ...builtinEnvironments.node,
  name: 'vue-node',
  viteEnvironment: 'client',
}
