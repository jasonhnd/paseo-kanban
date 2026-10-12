// Paseo settings screen for kanban.config.json. Leaders are shown and not edited.
// The screen title is fixed when the plugin registers; this form's own strings follow setLanguage.
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { deriveProjectCode, uniqueProjectCode } from "../../shared/card-code";
import { resolveLanguage, setLanguage, t, type LanguageSetting } from "../../shared/i18n";
import { LEADER_LABEL } from "../../shared/labels";
import { configReadRpc, configWriteRpc } from "../../shared/rpc";
import {
  INTEGER_THRESHOLD_KEYS,
  THRESHOLD_KEYS,
  newProjectSettings,
  thresholdLabel,
  type ProjectSettings,
  type SettingsDocument,
  type SettingsRead,
  type ThresholdKey,
} from "../../shared/settings";
import { useI18n } from "../i18n";
import { adoptPanelLanguage } from "../panel-title";
import { Button, Segmented, useStyles, type Styles } from "../ui";

type Texts = Record<string, string>;

const INTEGER_THRESHOLDS = new Set<ThresholdKey>(INTEGER_THRESHOLD_KEYS);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function textsFrom(form: SettingsDocument): Texts {
  const texts: Texts = {
    "concurrency.global": String(form.concurrency.global),
    disabledPools: form.disabledPools.join(", "),
    "banned.providers": form.bannedProviders.providers.join(", "),
    "banned.families": form.bannedProviders.families.join(", "),
    "banned.pools": form.bannedProviders.pools.join(", "),
    "banned.models": form.bannedProviders.models.join(", "),
  };
  for (const [name, row] of Object.entries(form.projects)) {
    texts[`project.${name}.code`] = row.code;
    texts[`project.${name}.base`] = row.baseBranch;
    texts[`project.${name}.lanes`] = String(row.worktreeLanes);
  }
  for (const [name, value] of Object.entries(form.concurrency.pools)) texts[`pool.${name}`] = String(value);
  for (const [name, value] of Object.entries(form.concurrency.roles)) texts[`role.${name}`] = String(value);
  for (const [name, value] of Object.entries(form.staleStopPct)) texts[`stale.${name}`] = String(value);
  for (const key of THRESHOLD_KEYS) texts[`threshold.${key}`] = String(form.thresholds[key]);
  for (const [name, rule] of Object.entries(form.families)) {
    texts[`family.${name}.providers`] = rule.providers.join(", ");
    texts[`family.${name}.prefixes`] = rule.modelPrefixes.join(", ");
  }
  return texts;
}

function parseWhole(text: string, min: number): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= min ? value : null;
}

function parsePositive(text: string): number | null {
  const value = Number(text.trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

function splitComma(text: string): string[] {
  return text.split(",").map((part) => part.trim()).filter(Boolean);
}

/** Overlay the text fields onto a copy of the form. A bad field returns the message and leaves the copy unused. */
function applyTexts(form: SettingsDocument, texts: Texts): SettingsDocument | string {
  const next = clone(form);
  const global = parseWhole(texts["concurrency.global"] ?? "", 1);
  if (global === null) return t("settings.error.global");
  next.concurrency.global = global;
  for (const name of Object.keys(next.concurrency.pools)) {
    const value = parseWhole(texts[`pool.${name}`] ?? "", 0);
    if (value === null) return t("settings.error.number", { name: `${t("settings.concurrency.pools")} ${name}` });
    next.concurrency.pools[name] = value;
  }
  for (const name of Object.keys(next.concurrency.roles)) {
    const value = parseWhole(texts[`role.${name}`] ?? "", 0);
    if (value === null) return t("settings.error.number", { name: `${t("settings.concurrency.roles")} ${name}` });
    next.concurrency.roles[name] = value;
  }
  for (const name of Object.keys(next.staleStopPct)) {
    const value = Number((texts[`stale.${name}`] ?? "").trim());
    if (!Number.isFinite(value) || value < 0 || value > 100) return t("settings.error.percent", { name });
    next.staleStopPct[name] = value;
  }
  for (const key of THRESHOLD_KEYS) {
    const raw = texts[`threshold.${key}`] ?? "";
    const value = INTEGER_THRESHOLDS.has(key) ? parseWhole(raw, 1) : parsePositive(raw);
    if (value === null) {
      return t(INTEGER_THRESHOLDS.has(key) ? "settings.error.count" : "settings.error.positive", { name: thresholdLabel(key) });
    }
    next.thresholds[key] = value;
  }
  for (const [name, row] of Object.entries(next.projects)) {
    row.code = texts[`project.${name}.code`] ?? row.code;
    row.baseBranch = texts[`project.${name}.base`] ?? row.baseBranch;
    const lanes = parseWhole(texts[`project.${name}.lanes`] ?? "", 1);
    if (lanes === null || lanes > 32) return t("settings.error.lanes", { project: name });
    row.worktreeLanes = lanes;
  }
  next.disabledPools = splitComma(texts.disabledPools ?? "");
  next.bannedProviders = {
    providers: splitComma(texts["banned.providers"] ?? ""),
    families: splitComma(texts["banned.families"] ?? ""),
    pools: splitComma(texts["banned.pools"] ?? ""),
    models: splitComma(texts["banned.models"] ?? ""),
  };
  for (const [name, rule] of Object.entries(next.families)) {
    rule.providers = splitComma(texts[`family.${name}.providers`] ?? "");
    rule.modelPrefixes = splitComma(texts[`family.${name}.prefixes`] ?? "");
  }
  return next;
}

function projectCode(form: SettingsDocument, name: string): string {
  const taken = new Set(Object.values(form.projects).map((row) => row.code.trim().toUpperCase()).filter(Boolean));
  try {
    return uniqueProjectCode(deriveProjectCode(name), taken);
  } catch {
    return "";
  }
}

function Field({ s, label, value, onChange }: { s: Styles; label: string; value: string; onChange: (value: string) => void }) {
  return (
    <View style={s.cardBody}>
      <Text style={s.secondary}>{label}</Text>
      <TextInput accessibilityLabel={label} value={value} onChangeText={onChange} style={s.input} autoCapitalize="none" autoCorrect={false} />
    </View>
  );
}

function Check({ s, label, value, onChange }: { s: Styles; label: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <Pressable accessibilityRole="checkbox" accessibilityLabel={label} accessibilityState={{ checked: value }} onPress={() => onChange(!value)} style={s.row}>
      <Text style={s.text}>{value ? "[x]" : "[ ]"} {label}</Text>
    </Pressable>
  );
}

function Section({ s, title, children }: { s: Styles; title: string; children: ReactNode }) {
  return (
    <View style={s.card}>
      <Text style={s.h2}>{title}</Text>
      {children}
    </View>
  );
}

export function SettingsScreen(props: PluginSurfaceProps) {
  const s = useStyles(props.theme, props.layout);
  const read = useRpc(configReadRpc);
  const write = useRpc(configWriteRpc);
  useI18n();
  const [view, setView] = useState<SettingsRead | null>(null);
  const [draft, setDraft] = useState<SettingsDocument | null>(null);
  const [texts, setTexts] = useState<Texts>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [poolName, setPoolName] = useState("");
  const [roleName, setRoleName] = useState("");
  const [staleName, setStaleName] = useState("");
  const [familyName, setFamilyName] = useState("");

  function take(result: SettingsRead): void {
    setView(result);
    if (result.document) {
      setDraft(result.document);
      setTexts(textsFrom(result.document));
    } else {
      setDraft(null);
    }
  }

  useEffect(() => {
    let live = true;
    read({})
      .then((result) => {
        if (live) take(result);
      })
      .catch((err: unknown) => {
        if (live) setNotice(err instanceof Error ? err.message : t("settings.error.broken"));
      });
    return () => {
      live = false;
    };
    // Read once per mount. Reload and a successful save call `read` again themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setText(key: string, value: string): void {
    setTexts((current) => ({ ...current, [key]: value }));
  }

  function patch(update: (form: SettingsDocument) => SettingsDocument): void {
    setDraft((current) => (current ? update(current) : current));
  }

  function addProject(name: string, code?: string): void {
    const trimmed = name.trim();
    if (!draft || !trimmed || draft.projects[trimmed]) {
      if (!trimmed) setNotice(t("settings.error.name"));
      return;
    }
    const row = newProjectSettings(code ?? projectCode(draft, trimmed));
    patch((form) => ({ ...form, projects: { ...form.projects, [trimmed]: row } }));
    setTexts((current) => ({
      ...current,
      [`project.${trimmed}.code`]: row.code,
      [`project.${trimmed}.base`]: row.baseBranch,
      [`project.${trimmed}.lanes`]: String(row.worktreeLanes),
    }));
    setProjectName("");
  }

  function addNumber(kind: "pool" | "role" | "stale", name: string, clear: () => void): void {
    const trimmed = name.trim();
    if (!trimmed) {
      setNotice(t("settings.error.poolName"));
      return;
    }
    if (kind === "stale") {
      patch((form) => ({ ...form, staleStopPct: { ...form.staleStopPct, [trimmed]: form.staleStopPct[trimmed] ?? 75 } }));
      setText(`stale.${trimmed}`, texts[`stale.${trimmed}`] ?? "75");
    } else if (kind === "pool") {
      patch((form) => ({
        ...form,
        concurrency: { ...form.concurrency, pools: { ...form.concurrency.pools, [trimmed]: form.concurrency.pools[trimmed] ?? 1 } },
      }));
      setText(`pool.${trimmed}`, texts[`pool.${trimmed}`] ?? "1");
    } else {
      patch((form) => ({
        ...form,
        concurrency: { ...form.concurrency, roles: { ...form.concurrency.roles, [trimmed]: form.concurrency.roles[trimmed] ?? 1 } },
      }));
      setText(`role.${trimmed}`, texts[`role.${trimmed}`] ?? "1");
    }
    clear();
  }

  async function reload(): Promise<void> {
    try {
      take(await read({}));
      setNotice(null);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : t("settings.error.broken"));
    }
  }

  async function save(): Promise<void> {
    if (!draft || !view || saving) return;
    const applied = applyTexts(draft, texts);
    if (typeof applied === "string") {
      setNotice(applied);
      return;
    }
    setSaving(true);
    try {
      const result = await write({ revision: view.revision, document: applied });
      if (result.ok || result.conflict) {
        take(result);
        const language = resolveLanguage(result.language);
        setLanguage(language);
        adoptPanelLanguage(language);
      }
      setNotice(result.message);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : t("settings.error.broken"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content}>
      <Text style={s.title}>{t("settings.screen.title")}</Text>
      {notice ? <Text style={s.secondary}>{notice}</Text> : null}
      {view === null ? <Text style={s.muted}>{t("settings.loading")}</Text> : null}
      {view?.problem && !view.document ? (
        <View style={s.card} testID="settings-problem">
          <Text style={s.h2}>{t("settings.problem.title")}</Text>
          <Text style={s.text}>{view.problem}</Text>
          <Button s={s} label={t("settings.reload")} tone="secondary" onPress={() => void reload()} />
        </View>
      ) : null}
      {view?.needsSetup ? (
        <View style={s.banner} testID="settings-setup">
          <Text style={s.h2}>{t("settings.setup.title")}</Text>
          <Text style={s.secondary}>{t("settings.setup.body")}</Text>
        </View>
      ) : null}
      {draft && view ? (
        <>
          <Section s={s} title={t("settings.language.title")}>
            {view.envOverride ? <Text style={s.warn}>{t("settings.language.envOverride")}</Text> : null}
            <Segmented
              s={s}
              label={t("settings.language.title")}
              value={draft.language}
              options={[
                { value: "en" as LanguageSetting, label: t("settings.language.option.en") },
                { value: "zh-CN" as LanguageSetting, label: t("settings.language.option.zh-CN") },
                { value: "system" as LanguageSetting, label: t("settings.language.option.system") },
              ]}
              onChange={(language) => patch((form) => ({ ...form, language }))}
            />
          </Section>

          <Section s={s} title={t("settings.projects.title")}>
            {view.candidatesNote ? <Text style={s.warn}>{view.candidatesNote}</Text> : null}
            {view.candidates.filter((candidate) => !draft.projects[candidate.name]).map((candidate) => (
              <Button key={candidate.name} s={s} label={t("settings.candidates.add", { name: candidate.name })} tone="secondary" onPress={() => addProject(candidate.name)} />
            ))}
            {view.needsSetup && view.candidates.length === 0 ? <Text style={s.muted}>{t("settings.setup.noCandidates")}</Text> : null}
            <Field s={s} label={t("settings.projects.name")} value={projectName} onChange={setProjectName} />
            <Button s={s} label={t("settings.projects.add")} tone="secondary" onPress={() => addProject(projectName)} />
            {Object.keys(draft.projects).length === 0 ? <Text style={s.muted}>{t("settings.projects.empty")}</Text> : null}
            {Object.entries(draft.projects).map(([name, row]) => (
              <ProjectCard
                key={name}
                s={s}
                name={name}
                row={row}
                texts={texts}
                onText={setText}
                onRow={(next) => patch((form) => ({ ...form, projects: { ...form.projects, [name]: next } }))}
                onRemove={() => patch((form) => {
                  const projects = { ...form.projects };
                  delete projects[name];
                  return { ...form, projects };
                })}
              />
            ))}
          </Section>

          <Section s={s} title={t("settings.leaders.title")}>
            <Text style={s.secondary}>{t("settings.leaders.body", { leader: LEADER_LABEL })}</Text>
            {view.leaders.length === 0 ? <Text style={s.muted}>{t("settings.leaders.none", { leader: LEADER_LABEL })}</Text> : null}
            {view.leaders.map((leader) => (
              <Text key={leader.project} style={s.text}>{t("settings.leaders.line", { project: leader.project, agent: leader.agentId })}</Text>
            ))}
            <Text style={s.secondary}>
              {view.fallbackLeader
                ? t("settings.leaders.fallback", { leader: LEADER_LABEL, agent: view.fallbackLeader })
                : t("settings.leaders.noFallback", { leader: LEADER_LABEL })}
            </Text>
          </Section>

          <Section s={s} title={t("settings.concurrency.title")}>
            <Text style={s.muted}>{t("settings.concurrency.hint")}</Text>
            <Field s={s} label={t("settings.concurrency.global")} value={texts["concurrency.global"] ?? ""} onChange={(value) => setText("concurrency.global", value)} />
            <NumberRows s={s} title={t("settings.concurrency.pools")} prefix="pool" values={draft.concurrency.pools} texts={texts} onText={setText} onRemove={(name) => patch((form) => {
              const pools = { ...form.concurrency.pools };
              delete pools[name];
              return { ...form, concurrency: { ...form.concurrency, pools } };
            })} />
            <Field s={s} label={t("settings.concurrency.name")} value={poolName} onChange={setPoolName} />
            <Button s={s} label={t("settings.concurrency.add")} tone="secondary" onPress={() => addNumber("pool", poolName, () => setPoolName(""))} />
            <NumberRows s={s} title={t("settings.concurrency.roles")} prefix="role" values={draft.concurrency.roles} texts={texts} onText={setText} onRemove={(name) => patch((form) => {
              const roles = { ...form.concurrency.roles };
              delete roles[name];
              return { ...form, concurrency: { ...form.concurrency, roles } };
            })} />
            <Field s={s} label={t("settings.concurrency.name")} value={roleName} onChange={setRoleName} />
            <Button s={s} label={t("settings.concurrency.add")} tone="secondary" onPress={() => addNumber("role", roleName, () => setRoleName(""))} />
          </Section>

          <Section s={s} title={t("settings.thresholds.title")}>
            <Text style={s.secondary}>{t("settings.thresholds.staleStop")}</Text>
            <NumberRows s={s} title={t("settings.thresholds.pool")} prefix="stale" values={draft.staleStopPct} texts={texts} onText={setText} onRemove={(name) => patch((form) => {
              const staleStopPct = { ...form.staleStopPct };
              delete staleStopPct[name];
              return { ...form, staleStopPct };
            })} />
            <Field s={s} label={t("settings.thresholds.pool")} value={staleName} onChange={setStaleName} />
            <Button s={s} label={t("settings.thresholds.addPool")} tone="secondary" onPress={() => addNumber("stale", staleName, () => setStaleName(""))} />
            {THRESHOLD_KEYS.map((key) => (
              <Field key={key} s={s} label={thresholdLabel(key)} value={texts[`threshold.${key}`] ?? ""} onChange={(value) => setText(`threshold.${key}`, value)} />
            ))}
          </Section>

          <Section s={s} title={t("settings.families.title")}>
            {Object.entries(draft.families).map(([name, rule]) => (
              <View key={name} style={s.cardBody}>
                <Text style={s.cardTitle}>{name}</Text>
                <Field s={s} label={t("settings.families.providers")} value={texts[`family.${name}.providers`] ?? ""} onChange={(value) => setText(`family.${name}.providers`, value)} />
                <Field s={s} label={t("settings.families.prefixes")} value={texts[`family.${name}.prefixes`] ?? ""} onChange={(value) => setText(`family.${name}.prefixes`, value)} />
                <Text style={s.muted}>{t("settings.field.comma")}</Text>
                <Check s={s} label={t("settings.families.noFast")} value={rule.noFast} onChange={(noFast) => patch((form) => ({ ...form, families: { ...form.families, [name]: { ...rule, noFast } } }))} />
                <Check s={s} label={t("settings.families.noUltra")} value={rule.noUltra} onChange={(noUltra) => patch((form) => ({ ...form, families: { ...form.families, [name]: { ...rule, noUltra } } }))} />
                <Check s={s} label={t("settings.families.requirePool")} value={rule.requirePoolSeen} onChange={(requirePoolSeen) => patch((form) => ({ ...form, families: { ...form.families, [name]: { ...rule, requirePoolSeen } } }))} />
                <Button s={s} label={t("settings.families.remove", { name })} tone="danger" onPress={() => patch((form) => {
                  const families = { ...form.families };
                  delete families[name];
                  return { ...form, families };
                })} />
              </View>
            ))}
            <Field s={s} label={t("settings.families.name")} value={familyName} onChange={setFamilyName} />
            <Button s={s} label={t("settings.families.add")} tone="secondary" onPress={() => {
              const name = familyName.trim();
              if (!name) {
                setNotice(t("settings.error.poolName"));
                return;
              }
              patch((form) => ({
                ...form,
                families: {
                  ...form.families,
                  [name]: form.families[name] ?? { providers: [], modelPrefixes: [], noFast: false, noUltra: false, requirePoolSeen: false },
                },
              }));
              setTexts((current) => ({
                ...current,
                [`family.${name}.providers`]: current[`family.${name}.providers`] ?? "",
                [`family.${name}.prefixes`]: current[`family.${name}.prefixes`] ?? "",
              }));
              setFamilyName("");
            }} />
          </Section>

          <Section s={s} title={t("settings.banned.title")}>
            <Field s={s} label={t("settings.banned.providers")} value={texts["banned.providers"] ?? ""} onChange={(value) => setText("banned.providers", value)} />
            <Field s={s} label={t("settings.banned.families")} value={texts["banned.families"] ?? ""} onChange={(value) => setText("banned.families", value)} />
            <Field s={s} label={t("settings.banned.pools")} value={texts["banned.pools"] ?? ""} onChange={(value) => setText("banned.pools", value)} />
            <Field s={s} label={t("settings.banned.models")} value={texts["banned.models"] ?? ""} onChange={(value) => setText("banned.models", value)} />
            <Text style={s.muted}>{t("settings.field.comma")}</Text>
          </Section>

          <Section s={s} title={t("settings.disabledPools.title")}>
            <Field s={s} label={t("settings.disabledPools.title")} value={texts.disabledPools ?? ""} onChange={(value) => setText("disabledPools", value)} />
            <Text style={s.muted}>{t("settings.disabledPools.hint")}</Text>
          </Section>

          <View style={s.row}>
            <Button s={s} label={saving ? t("settings.saving") : t("settings.save")} onPress={() => void save()} disabled={saving} />
            <Button s={s} label={t("settings.reload")} tone="secondary" onPress={() => void reload()} />
          </View>
        </>
      ) : null}
    </ScrollView>
  );
}

function ProjectCard({
  s,
  name,
  row,
  texts,
  onText,
  onRow,
  onRemove,
}: {
  s: Styles;
  name: string;
  row: ProjectSettings;
  texts: Texts;
  onText: (key: string, value: string) => void;
  onRow: (row: ProjectSettings) => void;
  onRemove: () => void;
}) {
  return (
    <View style={s.cardBody}>
      <Text style={s.cardTitle}>{name}</Text>
      <Field s={s} label={t("settings.projects.code")} value={texts[`project.${name}.code`] ?? ""} onChange={(value) => onText(`project.${name}.code`, value)} />
      <Field s={s} label={t("settings.projects.base")} value={texts[`project.${name}.base`] ?? ""} onChange={(value) => onText(`project.${name}.base`, value)} />
      {row.defaultWorkspace === "worktree" ? (
        <>
          <Text style={s.secondary}>{t("settings.projects.workspace.kept")}</Text>
          <Button s={s} label={t("settings.projects.workspace.dir")} tone="secondary" onPress={() => onRow({ ...row, defaultWorkspace: "dir" })} />
        </>
      ) : (
        <Text style={s.secondary}>{t("settings.projects.workspace.dir")}</Text>
      )}
      <Field s={s} label={t("settings.projects.lanes")} value={texts[`project.${name}.lanes`] ?? ""} onChange={(value) => onText(`project.${name}.lanes`, value)} />
      <Check s={s} label={t("settings.projects.lanesEnabled")} value={row.lanesEnabled} onChange={(lanesEnabled) => onRow({ ...row, lanesEnabled })} />
      <Check s={s} label={t("settings.projects.parallel")} value={row.parallel} onChange={(parallel) => onRow({ ...row, parallel })} />
      <Check s={s} label={t("settings.projects.alwaysTemp")} value={row.alwaysTemp} onChange={(alwaysTemp) => onRow({ ...row, alwaysTemp })} />
      <Check s={s} label={t("settings.projects.waitParentPr")} value={row.waitParentPr} onChange={(waitParentPr) => onRow({ ...row, waitParentPr })} />
      <Check s={s} label={t("settings.projects.autoStart")} value={row.autoStart} onChange={(autoStart) => onRow({ ...row, autoStart })} />
      <Button s={s} label={t("settings.projects.remove", { name })} tone="danger" onPress={onRemove} />
    </View>
  );
}

function NumberRows({
  s,
  title,
  prefix,
  values,
  texts,
  onText,
  onRemove,
}: {
  s: Styles;
  title: string;
  prefix: string;
  values: Record<string, number>;
  texts: Texts;
  onText: (key: string, value: string) => void;
  onRemove: (name: string) => void;
}) {
  const names = Object.keys(values);
  if (names.length === 0) return null;
  return (
    <View style={s.cardBody}>
      <Text style={s.cardTitle}>{title}</Text>
      {names.map((name) => (
        <View key={name} style={s.cardBody}>
          <Field s={s} label={name} value={texts[`${prefix}.${name}`] ?? ""} onChange={(value) => onText(`${prefix}.${name}`, value)} />
          <Button s={s} label={t("settings.concurrency.remove", { name })} tone="danger" onPress={() => onRemove(name)} />
        </View>
      ))}
    </View>
  );
}
