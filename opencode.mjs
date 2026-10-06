// OpenCode plugin for V1 and V2. V1 (>=1.18.29) calls `server()`; V2 calls
// `setup(ctx)`. Keep this module dependency-free with the default export as
// its only export: older V1 loaders invoke every export as a plugin.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bundledSkills = fileURLToPath(new URL('./opencode-skills', import.meta.url));

// The generator writes single-line `name:` and `description:` frontmatter.
function bundledSkillInfos() {
  return fs.readdirSync(bundledSkills, { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
    .map(id => {
      const file = path.join(bundledSkills, id, 'SKILL.md');
      const text = fs.readFileSync(file, 'utf8');
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
      if (!frontmatter) throw new Error(`agy-staff: missing frontmatter in ${file}`);
      const field = key => new RegExp(`^${key}:[ \\t]*(.+)$`, 'm').exec(frontmatter[1])?.[1].trim();
      return { id, name: field('name') ?? id, description: field('description'), path: file, content: text.slice(frontmatter[0].length).trim() };
    });
}

export default {
  id: 'agy-staff',
  // V1 discovers the skills from this path and derives same-named commands.
  server: async () => ({
    config: async config => {
      config.skills ??= {};
      config.skills.paths ??= [];
      if (!config.skills.paths.includes(bundledSkills)) config.skills.paths.push(bundledSkills);
    },
  }),
  // V2 has no config hook and no skill-derived commands: register both. Each
  // command resubmits the user's prompt with its skill attached.
  async setup(ctx) {
    const skills = bundledSkillInfos();
    await ctx.skill.transform(editor => {
      for (const skill of skills) editor.add(skill);
    });
    await ctx.command.transform(editor => {
      for (const { id, name, description } of skills) {
        editor.add({
          name: id,
          description,
          execute: ({ sessionID, prompt, delivery }) => ctx.session.prompt({
            ...prompt,
            sessionID,
            skills: [...(prompt.skills ?? []).filter(skill => skill.id !== id), { id, name }],
            ...(delivery === undefined ? {} : { delivery }),
          }),
        });
      }
    });
  },
};
