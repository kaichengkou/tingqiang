// Typed registry of downloadable models and a factory for constructing a
// separator from a registry name. All four current entries are MDX models;
// the `architecture` discriminant exists so a future 'roformer' (or other)
// arm can be added without disturbing MDX callers.
import { MDXSeparator, MDXArchConfig } from '../separator/architectures/mdx_separator';
import { SeparatorConfig } from '../separator/common_separator';

export interface MdxModelDefinition {
  architecture: 'mdx';
  /** Registry key / display name */
  name: string;
  downloadUrl: string;
  /** python-audio-separator-shaped params (names kept for upstream parity) */
  modelData: {
    compensate: number;
    mdx_dim_f_set: number;
    mdx_dim_t_set: number;
    mdx_n_fft_scale_set: number;
    primary_stem: 'Vocals' | 'Instrumental';
    is_karaoke?: boolean;
  };
  /** one-line human description of what this model does */
  description: string;
}

// Union grows with new architectures (e.g. a future 'roformer' definition).
export type ModelDefinition = MdxModelDefinition;

export const MODEL_REGISTRY = {
  UVR_MDXNET_KARA_2: {
    architecture: 'mdx',
    name: 'UVR_MDXNET_KARA_2',
    downloadUrl: 'https://huggingface.co/AI4future/RVC/resolve/main/UVR_MDXNET_KARA_2.onnx',
    modelData: {
      compensate: 1.065,
      mdx_dim_f_set: 2048,
      mdx_dim_t_set: 8,
      mdx_n_fft_scale_set: 5120,
      primary_stem: 'Instrumental',
      is_karaoke: true,
    },
    description: 'Karaoke model: removes lead vocals but keeps backing vocals in the instrumental.',
  },
  'UVR-MDX-NET-Voc_FT': {
    architecture: 'mdx',
    name: 'UVR-MDX-NET-Voc_FT',
    downloadUrl: 'https://huggingface.co/Blane187/all_public_uvr_models/resolve/main/UVR-MDX-NET-Voc_FT.onnx',
    // sha256 534b2070fcc7df514b13ef660dc8cbb328679c2374d04354a5c42bb14ecce111, 66762490 bytes
    modelData: {
      compensate: 1.021,
      mdx_dim_f_set: 3072,
      mdx_dim_t_set: 8,
      mdx_n_fft_scale_set: 7680,
      primary_stem: 'Vocals',
    },
    description: 'Fine-tuned vocal model: removes all vocals (lead and backing) from the mix.',
  },
  Kim_Vocal_2: {
    architecture: 'mdx',
    name: 'Kim_Vocal_2',
    downloadUrl: 'https://huggingface.co/Blane187/all_public_uvr_models/resolve/main/Kim_Vocal_2.onnx',
    // sha256 ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b, 66759214 bytes
    modelData: {
      compensate: 1.009,
      mdx_dim_f_set: 3072,
      mdx_dim_t_set: 8,
      mdx_n_fft_scale_set: 7680,
      primary_stem: 'Vocals',
    },
    description: 'High-accuracy vocal model: removes all vocals (lead and backing) from the mix.',
  },
  UVR_MDXNET_Main: {
    architecture: 'mdx',
    name: 'UVR_MDXNET_Main',
    downloadUrl: 'https://huggingface.co/Blane187/all_public_uvr_models/resolve/main/UVR_MDXNET_Main.onnx',
    // sha256 8289784cda38543ff431add4070662813311a8cccfc0112ca82f76d9dba2b4ca, 66759214 bytes
    modelData: {
      compensate: 1.043,
      mdx_dim_f_set: 3072,
      mdx_dim_t_set: 8,
      mdx_n_fft_scale_set: 7680,
      primary_stem: 'Vocals',
    },
    description: 'General-purpose vocal model: removes all vocals (lead and backing) from the mix.',
  },
  'UVR-MDX-NET-Inst_HQ_3': {
    architecture: 'mdx',
    name: 'UVR-MDX-NET-Inst_HQ_3',
    downloadUrl: 'https://huggingface.co/Blane187/all_public_uvr_models/resolve/main/UVR-MDX-NET-Inst_HQ_3.onnx',
    // sha256 317554b07fe1ea5279a77f2b1520a41ea4b93432560c4ffd08792c30fddf9adc, 66759214 bytes
    // Not present in UVR's current hash-keyed model_data_new.json (dropped from
    // active config upstream); params instead confirmed via the model's ONNX
    // graph shape (dim_f=3072) cross-checked against karafan's Models.csv,
    // which matches this repo's other 3072-dim_f entries exactly.
    modelData: {
      compensate: 1.022,
      mdx_dim_f_set: 3072,
      mdx_dim_t_set: 8,
      mdx_n_fft_scale_set: 6144,
      primary_stem: 'Instrumental',
    },
    description: 'High-quality instrumental model: removes all vocals (lead and backing), tuned for cleaner instrumentals.',
  },
} as const satisfies Record<string, ModelDefinition>;

export type RegisteredModelName = keyof typeof MODEL_REGISTRY;

/**
 * Build an MDXSeparator for a registered model name. Derives
 * primaryStemName/secondaryStemName (lowercase) from the model's
 * primary_stem; explicit values in `config.common` override the derived
 * ones. downloadUrl is threaded through to SeparatorConfig.modelUrl so
 * downloadModel() fetches the right file.
 *
 * Throws at runtime for an unregistered name, since plain-JS callers aren't
 * type-checked against RegisteredModelName.
 */
export function createSeparator(
  modelName: RegisteredModelName,
  config?: { common?: Partial<SeparatorConfig>; mdx?: MDXArchConfig }
): MDXSeparator {
  const definition: ModelDefinition | undefined = MODEL_REGISTRY[modelName];
  if (!definition) {
    throw new Error(`createSeparator: unknown model "${modelName}". Known models: ${Object.keys(MODEL_REGISTRY).join(', ')}`);
  }

  const primaryStemName = definition.modelData.primary_stem === 'Vocals' ? 'vocals' : 'instrumental';
  const secondaryStemName = primaryStemName === 'vocals' ? 'instrumental' : 'vocals';

  const commonConfig: SeparatorConfig = {
    modelPath: definition.downloadUrl,
    modelName: definition.name,
    modelData: definition.modelData,
    modelUrl: definition.downloadUrl,
    primaryStemName,
    secondaryStemName,
    ...config?.common,
  };

  switch (definition.architecture) {
    case 'mdx':
      return new MDXSeparator(commonConfig, config?.mdx ?? {});
    default: {
      const _exhaustive: never = definition.architecture;
      throw new Error(`createSeparator: unsupported architecture "${_exhaustive}"`);
    }
  }
}
