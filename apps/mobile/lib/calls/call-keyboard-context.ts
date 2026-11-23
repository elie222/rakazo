import { createContext } from "react";

// Screen avoiders yield to the root while call controls share its keyboard space.
export const CallKeyboardContext = createContext(false);
