export interface AdapterEntry {
  name: string;
  label: string;
  importPath: string;
  color: string;
}

export const NEW_ADAPTERS: AdapterEntry[] = [
  {
    color: "#FF6A00",
    importPath: "files-sdk/alibaba",
    label: "Alibaba Cloud OSS",
    name: "alibaba",
  },
  {
    color: "#3448C5",
    importPath: "files-sdk/cloudinary",
    label: "Cloudinary",
    name: "cloudinary",
  },
  {
    color: "#036C70",
    importPath: "files-sdk/sharepoint",
    label: "SharePoint",
    name: "sharepoint",
  },
  {
    color: "#006EFF",
    importPath: "files-sdk/tencent",
    label: "Tencent Cloud COS",
    name: "tencent",
  },
  {
    color: "#FF0000",
    importPath: "files-sdk/yandex",
    label: "Yandex Object Storage",
    name: "yandex",
  },
  {
    color: "#F472B6",
    importPath: "files-sdk/bun-s3",
    label: "Bun S3",
    name: "bunS3",
  },
];
