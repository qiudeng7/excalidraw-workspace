/** Runtime-only development credentials; never import defaults into the application. */
export interface DevelopmentAccount {
  role: "admin" | "user";
  email: string;
  password: string;
  name: string;
}

export function parseDevelopmentAccounts(value: string): DevelopmentAccount[] {
  const accounts: unknown = JSON.parse(value);

  if (!Array.isArray(accounts) || accounts.length !== 2)
    throw new Error("开发账号必须包含一个管理员和一个普通用户");
  for (const [index, role] of ["admin", "user"].entries()) {
    const account = accounts[index];

    if (
      !account ||
      account.role !== role ||
      typeof account.email !== "string" ||
      account.email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email) ||
      typeof account.password !== "string" ||
      account.password.length < 12 ||
      account.password.length > 256 ||
      typeof account.name !== "string" ||
      !account.name.trim()
    )
      throw new Error(
        `开发 ${role} 账号配置无效：邮箱、昵称和 12–256 位密码必填`,
      );
  }

  if (accounts[0].email === accounts[1].email)
    throw new Error("管理员和普通用户必须使用不同邮箱");

  return accounts;
}
