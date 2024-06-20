export interface PackageListener {
  onPackageDone?(jobUrl: string): void;
  //eslint-disable-next-line @typescript-eslint/no-explicit-any
  onPackageFail?(message: string, err: any): void;
  onPackageStart?(jobUrl: string): void;
}
