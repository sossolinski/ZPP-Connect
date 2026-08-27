import type { PrismaClient } from "@prisma/client";
import { defaultProfile, dictionaries } from "@zpp/shared";
import { dictionaryPolicy, normalizeDictionaryKey } from "../src/modules/configuration/dictionary-policy.js";

export async function seedDictionaries(prisma: PrismaClient) {
  const profileRows: Array<[string, string, string]> = [
    ["profile", "organizationName", defaultProfile.organizationName],
    ["profile", "appSubtitle", defaultProfile.appSubtitle],
    ["profile", "genericSubtitle", defaultProfile.genericSubtitle],
    ["profile", "teamName", defaultProfile.teamName],
    ["profile", "contactEmail", defaultProfile.contactEmail],
    ["profile", "author", defaultProfile.author],
    ["profile", "footerText", defaultProfile.footerText],
  ];

  for (let index = 0; index < profileRows.length; index += 1) {
    const [category, key, label] = profileRows[index]!;
    await prisma.dictionary.upsert({
      where: { profile_category_key: { profile: defaultProfile.id, category, key } },
      update: {},
      create: {
        profile: defaultProfile.id,
        category,
        key,
        normalizedKey: normalizeDictionaryKey(key),
        label,
        sortOrder: index,
        sourceType: "LEGACY_PROFILE_MIRROR",
      },
    });
  }

  for (const [category, values] of Object.entries(dictionaries)) {
    const policy = dictionaryPolicy(category);
    for (let index = 0; index < values.length; index += 1) {
      const label = values[index]!;
      const key = normalizeDictionaryKey(label);
      await prisma.dictionary.upsert({
        where: { profile_category_key: { profile: defaultProfile.id, category, key } },
        update: policy.authority === "postgres"
          ? {}
          : { normalizedKey: key, label, sortOrder: index, isActive: true, sourceType: "SYSTEM_MIRROR" },
        create: {
          profile: defaultProfile.id,
          category,
          key,
          normalizedKey: key,
          label,
          sortOrder: index,
          isActive: true,
          sourceType: policy.authority === "postgres" ? "BOOTSTRAP" : "SYSTEM_MIRROR",
        },
      });
    }
  }
}
