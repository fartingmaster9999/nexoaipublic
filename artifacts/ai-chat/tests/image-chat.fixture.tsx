import { createRoot } from "react-dom/client";
import App from "@/App";

import "../src/index.css";
import "../src/nexo.css";
import "../src/refine.css";
import "../src/landing.css";
import "../src/ux-polish.css";
import "../src/answer-format.css";

history.replaceState(null, "", "/");
createRoot(document.getElementById("root")!).render(<App />);
