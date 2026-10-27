import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

// gui() already includes vite-plugin-solid; adding solid() here as well would compile the JSX twice.
export default defineConfig({ plugins: [gui()] })
