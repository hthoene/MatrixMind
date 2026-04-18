import path from "path";
import { WorkspaceManager } from "../room/WorkspaceManager.js";
import { estimateTokens } from "../utils/hash.js";
import { getLogger } from "../logger.js";

const log = getLogger("SkillLoader");

const MAX_SKILL_TOKENS = 400;

export interface Skill {
  name: string;
  content: string;
}

export class SkillLoader {
  constructor(
    private readonly workspace: WorkspaceManager,
    private readonly workspacePath: string
  ) {}

  /**
   * Returns skills whose content has a keyword match with `query`.
   * Never loads all skills at once – only matched ones.
   */
  loadMatching(query: string): Skill[] {
    const allSkills = this.listAll();
    const queryWords = tokenize(query);
    const matched: Skill[] = [];

    for (const skill of allSkills) {
      const skillWords = tokenize(skill.content);
      const hasMatch = queryWords.some((w) => skillWords.includes(w));
      if (hasMatch) {
        matched.push({
          ...skill,
          content: truncate(skill.content, MAX_SKILL_TOKENS),
        });
      }
    }

    log.debug({ matched: matched.map((s) => s.name) }, "Skills matched");
    return matched;
  }

  private listAll(): Skill[] {
    const skills: Skill[] = [];

    for (const subdir of ["skills", "skills/defaults"]) {
      try {
        const files = this.workspace.listFiles(this.workspacePath, subdir);
        for (const file of files) {
          if (!file.endsWith(".md")) continue;
          try {
            const content = this.workspace.readFile(
              this.workspacePath,
              `${subdir}/${file}`
            );
            skills.push({ name: path.basename(file, ".md"), content });
          } catch (err) {
            log.warn({ err, file }, "Could not read skill file");
          }
        }
      } catch {
        // subdir may not exist yet
      }
    }

    return skills;
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
}

function truncate(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  return text.slice(0, maxTokens * 4) + "\n…";
}
