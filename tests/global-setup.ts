import { copyFileSync, existsSync } from "node:fs";

// Tests read config/portfolio.yaml; a fresh clone or CI runner only has the example.
export default function setup(): void {
  if (!existsSync("config/portfolio.yaml") && existsSync("config/portfolio.example.yaml")) {
    copyFileSync("config/portfolio.example.yaml", "config/portfolio.yaml");
  }
}
