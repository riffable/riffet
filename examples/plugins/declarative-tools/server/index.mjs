export default {
  activate() {
    return {
      commands: {
        'example.declarative-tools/echo': {
          async run({ args }) { return { kind: 'done', message: { en: String(args.text), 'zh-Hans': String(args.text) } }; },
        },
      },
    };
  },
};
