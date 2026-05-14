import React from 'react';

type TokencLogoProps = {
  className?: string;
};

const TokencLogo = ({ className = 'w-5 h-5' }: TokencLogoProps) => {
  return (
    <img src="/icons/tokenc-ai-icon.svg" alt="Tokenc" className={className} />
  );
};

export default TokencLogo;
