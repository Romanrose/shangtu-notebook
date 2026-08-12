const COHORT_ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;

export function validateConsentedUserCases(cases) {
  if (!Array.isArray(cases) || !cases.length) throw new Error("consented_user 实验必须包含非空样本清单。");
  const cohortIds = new Set();
  for (const [index, sample] of cases.entries()) {
    const metadata = sample?.metadata;
    if (metadata?.evidence !== "consented_user" || typeof metadata.cohortId !== "string" || !COHORT_ID_PATTERN.test(metadata.cohortId) || metadata.consent !== "confirmed") {
      throw new Error(`consented_user 清单第 ${index + 1} 条样本必须声明 evidence=consented_user、有效 cohortId 和 consent=confirmed。`);
    }
    cohortIds.add(metadata.cohortId);
    if (typeof sample.expected !== "string" || !sample.expected.trim() || sample.expected.trim().length > 240) {
      throw new Error(`consented_user 清单第 ${index + 1} 条样本必须包含 1–240 字符的人工校对文本。`);
    }
  }
  if (cohortIds.size !== 1) throw new Error("consented_user 清单不能混合不同 cohortId。");
  return { cohortId: [...cohortIds][0] };
}
