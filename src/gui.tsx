import { Plugin } from "@opencode/plugin/gui"
import { definition } from "./definition"
import { setup } from "./ui/setup"

export default Plugin.define({ ...definition, setup })
