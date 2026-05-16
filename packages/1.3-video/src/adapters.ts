export interface AdapterEntry {
  name: string;
  label: string;
  importPath: string;
  color: string;
}

export const NEW_ADAPTERS: AdapterEntry[] = [
  {
    color: "#DC2626",
    importPath: "files-sdk/backblaze-b2",
    label: "Backblaze B2",
    name: "backblazeB2",
  },
  {
    color: "#0F62FE",
    importPath: "files-sdk/ibm-cos",
    label: "IBM Cloud",
    name: "ibmCos",
  },
  {
    color: "#C74634",
    importPath: "files-sdk/oracle-cloud",
    label: "Oracle Cloud",
    name: "oracleCloud",
  },
  {
    color: "#01CD3F",
    importPath: "files-sdk/wasabi",
    label: "Wasabi",
    name: "wasabi",
  },
  {
    color: "#4F0599",
    importPath: "files-sdk/scaleway",
    label: "Scaleway",
    name: "scaleway",
  },
  {
    color: "#0050D7",
    importPath: "files-sdk/ovhcloud",
    label: "OVHcloud",
    name: "ovhcloud",
  },
  {
    color: "#1F2937",
    importPath: "files-sdk/tigris",
    label: "Tigris",
    name: "tigris",
  },
  {
    color: "#3B82F6",
    importPath: "files-sdk/exoscale",
    label: "Exoscale",
    name: "exoscale",
  },
  {
    color: "#1E40AF",
    importPath: "files-sdk/idrive-e2",
    label: "iDrive e2",
    name: "idriveE2",
  },
  {
    color: "#007BFC",
    importPath: "files-sdk/vultr",
    label: "Vultr",
    name: "vultr",
  },
  {
    color: "#0D9488",
    importPath: "files-sdk/filebase",
    label: "Filebase",
    name: "filebase",
  },
  {
    color: "#F02E65",
    importPath: "files-sdk/appwrite",
    label: "Appwrite",
    name: "appwrite",
  },
];
