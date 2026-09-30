export const FINANCIAL_ACCOUNT_RULES = Object.freeze({
  revenue: { ids: ["ifrs-full_Revenue"], names: ["매출액", "수익(매출액)", "영업수익"], sections: ["IS", "CIS"] },
  operatingProfit: {
    ids: ["dart_OperatingIncomeLoss"],
    names: ["영업이익", "영업이익(손실)"],
    fallbackIds: ["ifrs-full_ProfitLossFromOperatingActivities"],
    sections: ["IS", "CIS"],
  },
  netIncome: { ids: ["ifrs-full_ProfitLoss"], names: ["당기순이익", "당기순이익(손실)", "연결당기순이익"], sections: ["IS", "CIS"] },
  assets: { ids: ["ifrs-full_Assets"], names: ["자산총계"], sections: ["BS"] },
  liabilities: { ids: ["ifrs-full_Liabilities"], names: ["부채총계"], sections: ["BS"] },
  equity: { ids: ["ifrs-full_Equity"], names: ["자본총계"], sections: ["BS"] },
  interestExpense: { ids: ["ifrs-full_FinanceCosts"], names: ["이자비용", "금융비용", "이자비용(금융원가)"], sections: ["IS", "CIS"] },
});

const inSection = (row, rule) => !rule.sections?.length || rule.sections.includes(row.sj_div);

export function findFinancialAccountRow(list, rule) {
  const rows = list.filter((row) => inSection(row, rule));
  if (!rule.fallbackIds?.length) {
    return rows.find((row) => rule.ids.includes(row.account_id) || rule.names.includes(row.account_nm));
  }
  const byId = (ids = []) => rows.find((row) => ids.includes(row.account_id));
  const byName = (names = []) => rows.find((row) => names.includes(row.account_nm));

  // A fallback must never pre-empt an existing canonical ID or approved exact name.
  return byId(rule.ids) ?? byName(rule.names) ?? byId(rule.fallbackIds);
}
